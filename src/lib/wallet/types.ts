/**
 * The wallet boundary.
 *
 * Everything the application needs from a wallet is on this interface, and
 * nothing below it knows the application exists. That isolation is deliberate:
 * Photonic's connect protocol is a full-page redirect with no injected
 * provider, and if a different wallet (or a future Photonic with a real
 * provider API) arrives, only the adapter changes.
 *
 * Three things are true of every adapter, now and later:
 *
 *   - It never sees a seed phrase, a WIF or a private key. There is no method
 *     here that could carry one.
 *   - It never signs. It asks a wallet to sign, and the wallet's own approval
 *     screen is the security boundary.
 *   - It reports a broadcast only when a wallet has acknowledged one. There is
 *     no optimistic success.
 */

import type { UnsignedTransaction } from "@/lib/radiant/tx";

export interface WalletIdentity {
  /** Base58 P2PKH address the wallet proved control of. */
  readonly address: string;
  /** A WAVE name, when one resolves. Cosmetic; never used to authorize. */
  /**
   * Every WAVE name this address holds, sorted. Display sugar only, and never
   * an identity: a name is a mutable index lookup, and which one an owner
   * "means" is not something we can know — so all of them are kept and none is
   * promoted.
   */
  readonly waveNames?: readonly string[] | undefined;
  /** When the identity was established, for session expiry. */
  readonly connectedAt: number;
}

/** Why a wallet interaction did not complete. Each needs distinct UI copy. */
export type WalletFailure =
  /** The user declined at the wallet's approval screen. */
  | "rejected"
  /** The wallet was reached, but the request went stale before returning. */
  | "expired"
  /** The signature did not verify against the claimed address. */
  | "bad-signature"
  /** The wallet returned a partially signed PSBT instead of a broadcast. */
  | "incomplete"
  /** The wallet reported a broadcast failure. */
  | "broadcast-failed"
  /** No wallet appears to be reachable. */
  | "unavailable"
  /** Anything else. */
  | "failed";

export class WalletError extends Error {
  constructor(
    readonly failure: WalletFailure,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** What a broadcast round trip is for, carried across the trip to the wallet. */
export interface MarkContext {
  /** Digest of the file being marked. Never the file itself. */
  readonly digest: string;
  readonly label?: string | undefined;
  /** Where the HashMark record sits in the transaction we built. */
  readonly outputIndex: number;
}

export interface BroadcastResult {
  /** Present only when a wallet confirmed the transaction was accepted. */
  readonly txid: string;
}

export interface WalletAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * Begin proving control of an address. May navigate away from the page, so
   * callers must persist anything they need first.
   */
  connect(): Promise<void> | never;

  /**
   * Ask the wallet to sign and broadcast an unsigned transaction. May navigate
   * away; the result arrives through the adapter's callback handling.
   *
   * `context` describes the mark being made. The adapter records it with the
   * pending request, so the result that comes back can be matched to the
   * request that caused it — without that, a returned transaction id belongs to
   * no request and has to be refused.
   */
  signAndBroadcast(
    tx: UnsignedTransaction,
    context: MarkContext,
  ): Promise<void> | never;
}
