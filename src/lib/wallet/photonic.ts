"use client";

/**
 * Photonic Wallet adapter — the real `photonic-connect` v1 protocol.
 *
 * Photonic exposes **no injected provider and no custom URL scheme**. Its own
 * documentation is explicit: `#/connect?req=` is a web hash route, and
 * auto-return is web-only. So a wallet interaction is a full-page round trip:
 *
 *     hashmark → <wallet>/#/connect?req=<base64url envelope>
 *                → user approves in the wallet
 *                → wallet navigates to our callback with the result in the
 *                  URL FRAGMENT
 *
 * The fragment matters. It never leaves the browser, so a signature or a signed
 * PSBT never reaches a web server's access log, a proxy log, or a `Referer`
 * header. Photonic only honours a `callback` whose origin exactly matches the
 * envelope's declared `origin`, which stops one site routing another site's
 * signed result somewhere else.
 *
 * Because the page is navigated away and back, everything needed to resume is
 * persisted in `sessionStorage` first — the digest and the request id, never
 * the file.
 */

import { PHOTONIC_CONNECT_URL, APP_NAME, APP_URL, APP_WAVE_NAME } from "@/lib/config";
import type { UnsignedTransaction } from "@/lib/radiant/tx";
import { buildPsbt, psbtToBase64, MAX_PSBT_BASE64_LEN } from "@/lib/radiant/psbt";

import { WalletError, type MarkContext, type WalletAdapter } from "./types";

const CONNECT_PROTOCOL = "photonic-connect";
const CONNECT_VERSION = 1;

/** The namespaced challenge shape Photonic recognizes and badges in its UI. */
const CHALLENGE_NAMESPACE = "radiant:wallet-connect:v1";

export const CALLBACK_PATH = "/wallet/callback";

/** Where a pending round trip is parked while the tab is at the wallet. */
export const PENDING_KEY = "hashmark:pending-wallet-request";

export type PendingKind = "connect" | "attest" | "broadcast";

export interface PendingRequest {
  readonly kind: PendingKind;
  readonly id: string;
  readonly nonce: string;
  /**
   * The exact string the wallet was asked to sign, so the signature can be
   * verified on return. For a connect this is the namespaced challenge; for an
   * attestation it is the canonical HashMark statement.
   */
  readonly challenge?: string;
  /** Digest of the file being marked. Never the file itself. */
  readonly digest?: string;
  readonly label?: string;
  readonly outputIndex?: number;
  readonly createdAt: number;
}

/** A round trip older than this is stale; a returned result is not trusted. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function savePending(request: PendingRequest): void {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(request));
}

export function loadPending(): PendingRequest | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingRequest;
    if (Date.now() - parsed.createdAt > PENDING_TTL_MS) {
      clearPending();
      return null;
    }
    return parsed;
  } catch {
    clearPending();
    return null;
  }
}

export function clearPending(): void {
  sessionStorage.removeItem(PENDING_KEY);
}

function callbackUrl(): string {
  return `${APP_URL}${CALLBACK_PATH}`;
}

/**
 * The origin we declare to the wallet, and which our callback must match.
 *
 * In the browser this is the live origin rather than the configured one, so a
 * preview deployment or a local dev server binds its callback correctly instead
 * of pointing at production.
 */
function declaredOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : APP_URL;
}

function openWallet(envelope: Record<string, unknown>): never {
  const url = `${PHOTONIC_CONNECT_URL}?req=${toBase64Url(JSON.stringify(envelope))}`;
  window.location.href = url;
  // The tab is navigating away; nothing after this runs.
  throw new WalletError("failed", "Navigating to the wallet");
}

export const photonicWallet: WalletAdapter & {
  buildConnectRequest(): PendingRequest;
  buildAttestRequest(context: {
    message: string;
    digest: string;
    label?: string | undefined;
  }): PendingRequest;
  signStatement(context: {
    message: string;
    digest: string;
    label?: string | undefined;
  }): never;
  buildBroadcastRequest(
    tx: UnsignedTransaction,
    context: MarkContext,
  ): PendingRequest;
} = {
  id: "photonic",
  name: "Photonic Wallet",

  buildConnectRequest(): PendingRequest {
    const nonce = randomId();
    // Signed verbatim by the wallet and shown to the user before they approve.
    const challenge = `${CHALLENGE_NAMESPACE}:${nonce}:${APP_NAME} sign-in | ${APP_WAVE_NAME}`;
    return {
      kind: "connect",
      id: nonce,
      nonce,
      challenge,
      createdAt: Date.now(),
    };
  },

  connect(): never {
    const pending = this.buildConnectRequest();
    savePending(pending);

    const origin = declaredOrigin();
    openWallet({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-request",
      challenge: pending.challenge,
      id: pending.id,
      origin,
      app: APP_NAME,
      // Only honoured when its origin matches `origin` above.
      callback: `${origin}${CALLBACK_PATH}`,
    });
  },

  /**
   * A request to sign the HashMark statement itself.
   *
   * Deliberately a **separate** round trip from `connect`. The connect
   * challenge carries authorization meaning — a nonce for replay protection,
   * origin binding, session establishment, and a shape Photonic recognizes and
   * badges as a connection. Folding a file attestation into it would blur all
   * of that to save one trip, and an approval that means two things at once
   * means neither reliably.
   */
  buildAttestRequest(context: {
    message: string;
    digest: string;
    label?: string | undefined;
  }): PendingRequest {
    return {
      kind: "attest",
      id: randomId(),
      nonce: "",
      challenge: context.message,
      digest: context.digest,
      ...(context.label === undefined ? {} : { label: context.label }),
      createdAt: Date.now(),
    };
  },

  /**
   * Ask the wallet to sign a HashMark statement, then come back.
   *
   * Photonic renders the challenge verbatim, so the user sees the digest and
   * label they are attesting to rather than an opaque nonce. It will also badge
   * the request "Unrecognized", correctly: this is not a connect request, and
   * reshaping it to earn a green badge would misrepresent what is being
   * approved.
   */
  signStatement(context: {
    message: string;
    digest: string;
    label?: string | undefined;
  }): never {
    const pending = this.buildAttestRequest(context);
    savePending(pending);

    const origin = declaredOrigin();
    openWallet({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-request",
      challenge: pending.challenge,
      id: pending.id,
      origin,
      app: APP_NAME,
      callback: `${origin}${CALLBACK_PATH}`,
    });
  },

  buildBroadcastRequest(tx, context): PendingRequest {
    return {
      kind: "broadcast",
      id: randomId(),
      nonce: "",
      digest: context.digest,
      ...(context.label === undefined ? {} : { label: context.label }),
      outputIndex: context.outputIndex,
      createdAt: Date.now(),
    };
  },

  signAndBroadcast(tx: UnsignedTransaction, context: MarkContext): never {
    const psbt = psbtToBase64(buildPsbt(tx));

    if (psbt.length > MAX_PSBT_BASE64_LEN) {
      throw new WalletError(
        "failed",
        "This transaction is too large to send to the wallet through a link.",
      );
    }

    // A NEW pending record, saved before we navigate. The connect round trip
    // that came earlier cleared its own on return, so there is nothing here to
    // reuse — and a result arriving with no pending request is refused as a
    // replay, which would strand a transaction the wallet had already
    // broadcast.
    const pending = this.buildBroadcastRequest(tx, context);
    savePending(pending);

    const origin = declaredOrigin();

    openWallet({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "psbt-sign-request",
      psbt,
      // Only the literal `true` opts in to the wallet finalizing, extracting and
      // broadcasting, and returning a txid rather than a signed PSBT.
      broadcast: true,
      id: pending.id,
      origin,
      app: APP_NAME,
      callback: `${origin}${CALLBACK_PATH}`,
    });
  },
};

export { callbackUrl };
