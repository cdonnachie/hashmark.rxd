"use client";

/**
 * What survives the trip to the wallet and back.
 *
 * Photonic's connect protocol navigates the whole tab away, so React state is
 * gone by the time a result arrives. Anything needed to resume lives in
 * `sessionStorage`, which is per-tab and cleared when the tab closes.
 *
 * What is stored: a digest, a label, a filename for display, and the connected
 * address. What is never stored: the file, any part of its contents, or
 * anything from a wallet beyond a public address.
 */

import type { WalletIdentity } from "./types";

const IDENTITY_KEY = "hashmark:wallet-identity";
const DRAFT_KEY = "hashmark:mark-draft";
const ATTESTATION_KEY = "hashmark:attestation";

/** A connection older than this must be re-proved. */
const IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;

export interface MarkDraft {
  readonly digest: string;
  readonly label?: string | undefined;
  /** Shown locally so the user knows which file they were marking. Never sent. */
  readonly fileName?: string | undefined;
  readonly fileSize?: number | undefined;
}

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
}

export function saveIdentity(identity: WalletIdentity): void {
  sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function loadIdentity(): WalletIdentity | null {
  const identity = read<WalletIdentity>(IDENTITY_KEY);
  if (!identity) return null;
  if (Date.now() - identity.connectedAt > IDENTITY_TTL_MS) {
    clearIdentity();
    return null;
  }
  return identity;
}

/**
 * Attach resolved WAVE names to the stored identity.
 *
 * Separate from `saveIdentity` because names are resolved later, on a different
 * screen: the wallet callback redirects immediately and must not wait on a name
 * lookup to do it.
 */
export function setIdentityWaveNames(waveNames: readonly string[]): void {
  const identity = loadIdentity();
  if (!identity) return;
  saveIdentity({ ...identity, waveNames });
}

export function clearIdentity(): void {
  sessionStorage.removeItem(IDENTITY_KEY);
}

export function saveDraft(draft: MarkDraft): void {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function loadDraft(): MarkDraft | null {
  return read<MarkDraft>(DRAFT_KEY);
}

export function clearDraft(): void {
  sessionStorage.removeItem(DRAFT_KEY);
}

/**
 * A signature the wallet has produced over a HashMark statement, waiting to be
 * written into a transaction.
 *
 * Stored because signing and broadcasting are two separate trips to the wallet,
 * and the tab is navigated away in between. It is not a secret — it is destined
 * for a public chain — but it is only valid for the exact statement it covers,
 * so the digest and label it was signed over are kept with it and checked
 * before use.
 */
export interface StoredAttestation {
  readonly digest: string;
  readonly label?: string | undefined;
  /** The address the wallet signed with, already verified against the signature. */
  readonly address: string;
  /** That address's hash160, which the record commits to. */
  readonly signerHash160: string;
  /** The 65-byte compact recoverable signature, lowercase hex. */
  readonly signature: string;
}

export function saveAttestation(attestation: StoredAttestation): void {
  sessionStorage.setItem(ATTESTATION_KEY, JSON.stringify(attestation));
}

export function loadAttestation(): StoredAttestation | null {
  return read<StoredAttestation>(ATTESTATION_KEY);
}

export function clearAttestation(): void {
  sessionStorage.removeItem(ATTESTATION_KEY);
}
