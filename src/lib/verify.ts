/**
 * The one place a HashMark is judged verified or not.
 *
 * Every route that shows a result — /verify, /tx/[txid], /receipt — goes
 * through here, so there is a single definition of "verified" rather than
 * three that could drift apart.
 *
 * The rule this file exists to enforce: **the answer always comes from the
 * chain.** An index hit, a receipt, or a transaction id in a URL is only ever a
 * pointer telling us what to fetch. Nothing a caller supplies is echoed back as
 * a finding.
 */

import { decodeHashMarkScript, hexToBytes } from "@hashmark/protocol";
import type { DecodeResult, HashMarkRecord } from "@hashmark/protocol";

import { NETWORK } from "@/lib/config";
import {
  verifyAttestation,
  type AttestationFailure,
} from "@/lib/radiant/attestation";
import type {
  ConfirmationState,
  RadiantChain,
  TransactionDetails,
} from "@/lib/radiant/chain";
import { proveInclusion, type InclusionResult } from "@/lib/radiant/inclusion";

export interface VerifiedMark {
  readonly record: HashMarkRecord;
  /**
   * The address that signed this record, for v2 marks whose signature verified
   * against the signer they commit to. Absent on a v1 mark, which carries no
   * signer at all — never absent because a check was skipped.
   */
  readonly signer?: string | undefined;
  readonly txid: string;
  readonly outputIndex: number;
  readonly confirmations: number;
  readonly state: ConfirmationState;
  readonly blockHash?: string | undefined;
  /**
   * Unix seconds. Present only once confirmed — see HASHMARK_PROTOCOL.md §8.
   * When `inclusion` is proved, this is read from the proved header rather
   * than taken from the server's report.
   */
  readonly blockTime?: number | undefined;
  /**
   * Whether the block placement was proved against the shipped checkpoint,
   * fell back to the server's word, or was contradicted by the server's own
   * proofs. Burial depth is never covered: confirmations stay reported.
   */
  readonly inclusion?: InclusionResult | undefined;
}

export type MatchOutcome =
  /** The file matches this mark. */
  | "match"
  /** A HashMark exists here, but it records a different file. */
  | "different-file"
  /** No file was supplied, so nothing was compared. */
  | "not-compared";

export interface TransactionVerification {
  readonly transaction: TransactionDetails;
  /** Every output that carried a readable HashMark. */
  readonly marks: readonly VerifiedMark[];
  /**
   * Outputs that claimed to be HashMarks but could not be read. Surfaced rather
   * than hidden: a malformed record at a transaction the user was pointed to is
   * something they should be told about.
   */
  readonly problems: readonly OutputProblem[];
}

/**
 * An output that claimed to be a HashMark and is not usable.
 *
 * The two kinds are kept apart because they mean different things: `decode`
 * is a malformed or unreadable record, while `attestation` is a record that
 * read perfectly and whose *claim* did not hold up. Collapsing them would tell
 * someone debugging a hostile record that their bytes were corrupt.
 */
export type OutputProblem =
  | {
      readonly index: number;
      readonly kind: "decode";
      readonly result: Extract<DecodeResult, { ok: false }>;
    }
  | {
      readonly index: number;
      readonly kind: "attestation";
      readonly reason: AttestationFailure;
      readonly detail: string;
    };

/**
 * Fetch a transaction and decode every HashMark output in it.
 *
 * `NOT_HASHMARK` outputs are dropped silently — a HashMark transaction also
 * carries change and funding outputs, and most `OP_RETURN`s on Radiant belong
 * to other protocols entirely.
 */
export async function verifyTransaction(
  chain: RadiantChain,
  txid: string,
): Promise<TransactionVerification> {
  const transaction = await chain.getTransaction(txid);

  // Once per transaction, not per mark: every output shares the block. A
  // failure here never fails verification — the record and its signature are
  // checked either way — it only decides how the block placement is labelled.
  const inclusion = await proveInclusion(
    chain,
    transaction.txid,
    transaction.confirmations,
  );
  const blockTime =
    inclusion.kind === "proved" ? inclusion.blockTime : transaction.blockTime;

  const marks: VerifiedMark[] = [];
  const problems: OutputProblem[] = [];

  for (const output of transaction.outputs) {
    const bytes = hexToBytes(output.scriptHex);
    if (bytes === undefined) continue;

    const result = decodeHashMarkScript(bytes);
    if (!result.ok) {
      if (result.reason !== "NOT_HASHMARK") {
        problems.push({ index: output.index, kind: "decode", result });
      }
      continue;
    }

    const record = result.record;
    let signer: string | undefined;

    if (record.version >= 2) {
      // A v2 record that decodes is well-formed, not yet believed. Its
      // signature is checked against the signer it commits to, on the chain it
      // was actually found on — and a record whose claim fails is never shown
      // as a mark.
      const attestation = verifyAttestation(record, NETWORK.genesisHash);
      if (!attestation.ok) {
        problems.push({
          index: output.index,
          kind: "attestation",
          reason: attestation.reason,
          detail: attestation.detail,
        });
        continue;
      }
      signer = attestation.signer;
    }

    marks.push({
      record,
      signer,
      txid: transaction.txid,
      outputIndex: output.index,
      confirmations: transaction.confirmations,
      state: transaction.state,
      blockHash: transaction.blockHash,
      blockTime,
      inclusion,
    });
  }

  return { transaction, marks, problems };
}

/** Compare a locally computed digest against a mark, as bytes. */
export function compareDigest(
  mark: VerifiedMark,
  localDigest: string | undefined,
  localAlgorithm = "sha256",
): MatchOutcome {
  if (localDigest === undefined) return "not-compared";
  if (mark.record.algorithm !== localAlgorithm) return "different-file";
  return mark.record.digest === localDigest ? "match" : "different-file";
}

export interface DigestSearchResult {
  /** Marks confirmed against the chain, oldest first. */
  readonly marks: readonly VerifiedMark[];
  /** Hits the index returned that did not survive re-verification. */
  readonly rejected: number;
}

/** A search hint from an index. Never trusted; always re-verified on-chain. */
export interface IndexHit {
  readonly txid: string;
  readonly outputIndex: number;
  readonly height: number;
}

/**
 * Where hints come from. Injected rather than fixed, because the index and the
 * chain are two different parties: the server reaches the index over its REST
 * API, the browser asks this site for the same hints, and both then re-verify
 * against a Radiant node themselves. Neither one is allowed to take the index's
 * word for anything.
 */
export type DigestLookup = (digest: string) => Promise<readonly IndexHit[]>;

/**
 * Thrown when the digest index cannot be searched at all.
 *
 * Distinct from an empty result on purpose: "we could not search" and "we
 * searched and found nothing" must never be shown to a user as the same thing.
 * Every failure to reach, parse or trust the index lands here, so a broken
 * index can never surface as an absence of marks.
 */
export class HashMarkLookupUnavailable extends Error {
  constructor(
    message = "Digest search is unavailable right now. Verification by transaction id or receipt still works.",
  ) {
    super(message);
    this.name = "HashMarkLookupUnavailable";
  }
}

/**
 * Find marks for a digest, then **re-verify every one against the chain**.
 *
 * A hit whose on-chain record does not actually carry the digest we asked for
 * is discarded and counted in `rejected`. That is what reduces a hostile or
 * buggy index to a source of missed results rather than false ones
 * (HASHMARK_PROTOCOL.md §2.8).
 */
export async function searchDigest(
  chain: RadiantChain,
  digest: string,
  lookup: DigestLookup,
): Promise<DigestSearchResult> {
  const hits = await lookup(digest);

  const marks: VerifiedMark[] = [];
  let rejected = 0;

  for (const hit of hits) {
    try {
      const { marks: found } = await verifyTransaction(chain, hit.txid);
      const confirmed = found.find(
        (mark) =>
          mark.outputIndex === hit.outputIndex && mark.record.digest === digest,
      );
      if (confirmed) marks.push(confirmed);
      else rejected += 1;
    } catch {
      // A hit we cannot fetch cannot be shown as verified.
      rejected += 1;
    }
  }

  marks.sort((a, b) => {
    // Unconfirmed marks sort last: they are not yet evidence of anything.
    if (a.state === "unconfirmed" && b.state !== "unconfirmed") return 1;
    if (b.state === "unconfirmed" && a.state !== "unconfirmed") return -1;
    return b.confirmations - a.confirmations;
  });

  return { marks, rejected };
}

/** Format a block time for display, always in UTC and always labelled as such. */
export function formatBlockTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    dateStyle: "long",
    timeStyle: "short",
  });
}
