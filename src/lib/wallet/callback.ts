/**
 * Parsing what a wallet hands back.
 *
 * Everything here is untrusted input arriving in a URL fragment that anyone can
 * type. Nothing is believed on the strength of being present: a connect result
 * is accepted only if its signature verifies against the challenge we issued,
 * and a broadcast result is accepted only if the wallet actually reported a
 * transaction id.
 */

import { isTxid } from "@/lib/radiant/chain";
import { verifyRadiantSignedMessage } from "@/lib/radiant/signmessage";
import { isValidRadiantAddress } from "@/lib/radiant/address";

import type { PendingRequest } from "./photonic";

export type CallbackOutcome =
  | {
      kind: "connected";
      address: string;
    }
  | {
      /** A HashMark statement was signed. The signature is already checked to
       * recover to `address`; the caller still commits to that address in the
       * record, which is what makes the claim verifiable later. */
      kind: "attested";
      address: string;
      signatureBase64: string;
    }
  | {
      kind: "broadcast";
      txid: string;
    }
  | {
      kind: "rejected";
      /** The wallet's own words, when it supplied any. */
      message?: string | undefined;
    }
  | {
      kind: "error";
      message: string;
    };

/** Fragment parameters, e.g. `#nonce=abc&address=1…&signature=…`. */
export function parseFragment(fragment: string): URLSearchParams {
  return new URLSearchParams(fragment.replace(/^#/, ""));
}

/**
 * Interpret a wallet callback against the request that started it.
 *
 * `pending` is what we stored before navigating away. Without it there is
 * nothing to check a signature against, so a result cannot be accepted — that
 * is the replay guard, not a technicality.
 */
export function interpretCallback(
  params: URLSearchParams,
  pending: PendingRequest | null,
): CallbackOutcome {
  // Photonic reports a refusal or an error with these, per its
  // buildRejectCallbackUrl / buildErrorCallbackUrl helpers.
  const errorCode = params.get("error");
  if (errorCode) {
    const message = params.get("message") ?? undefined;
    if (/reject|denied|cancel/i.test(errorCode)) {
      return { kind: "rejected", message };
    }
    return {
      kind: "error",
      message: message ?? `The wallet reported an error (${errorCode}).`,
    };
  }

  if (!pending) {
    return {
      kind: "error",
      message:
        "This result does not match any request from this browser tab. It may be from an old link, or the tab may have been reloaded. Start again.",
    };
  }

  if (pending.kind === "connect" || pending.kind === "attest") {
    const address = params.get("address");
    const signature = params.get("signature");
    const nonce = params.get("nonce");

    if (!address || !signature) {
      return {
        kind: "error",
        message: "The wallet did not return a signed address.",
      };
    }
    if (!isValidRadiantAddress(address)) {
      return {
        kind: "error",
        message: "The wallet returned something that is not a Radiant address.",
      };
    }
    // The nonce is echoed from inside the challenge; a mismatch means this
    // result belongs to a different request.
    if (nonce !== null && nonce !== pending.nonce) {
      return {
        kind: "error",
        message: "This result belongs to a different request. Start again.",
      };
    }
    if (pending.challenge === undefined) {
      return { kind: "error", message: "The original challenge is missing." };
    }

    // The actual check. Without this, anyone could hand us any address.
    if (!verifyRadiantSignedMessage(address, pending.challenge, signature)) {
      return {
        kind: "error",
        message:
          "The signature does not match that address. The connection was not accepted.",
      };
    }

    return pending.kind === "attest"
      ? { kind: "attested", address, signatureBase64: signature }
      : { kind: "connected", address };
  }

  // A broadcast round trip.
  const txid = params.get("txid");
  const complete = params.get("complete");

  // Photonic echoes the request id (`#id=…&txid=…&complete=true`). Checked the
  // same way as the connect nonce: a mismatch is a result from some other
  // request, while an absent id is tolerated rather than assumed hostile.
  const id = params.get("id");
  if (id !== null && id !== pending.id) {
    return {
      kind: "error",
      message: "This result belongs to a different request. Start again.",
    };
  }

  if (txid) {
    if (!isTxid(txid.toLowerCase())) {
      return {
        kind: "error",
        message: "The wallet returned something that is not a transaction id.",
      };
    }
    return { kind: "broadcast", txid: txid.toLowerCase() };
  }

  // `broadcast: true` returns a PSBT instead of a txid when the transaction was
  // not completed — the wallet could not fully sign it, or the network refused
  // it. Either way nothing was published, and saying so plainly matters more
  // than guessing which.
  if (params.get("psbt")) {
    return {
      kind: "error",
      message:
        complete === "true"
          ? "The wallet signed the transaction but it was not accepted by the network. Nothing was published."
          : "The wallet could not fully sign this transaction, so nothing was broadcast.",
    };
  }

  return {
    kind: "error",
    message: "The wallet returned without a result. Nothing was published.",
  };
}
