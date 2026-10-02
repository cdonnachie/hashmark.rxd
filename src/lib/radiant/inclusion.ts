/**
 * Proving a transaction is in the block the server says it is in.
 *
 * Without this, a mark's block and timestamp are the connected node's word,
 * and a node that misreported the height would move the moment the whole
 * answer is about (HASHMARK_PROTOCOL.md §2.3.2). With it, the server supplies
 * two Merkle branches and one 80-byte header, and every byte is checked:
 *
 *   1. the transaction's branch must land on the header's merkle root
 *      — the transaction is in this block;
 *   2. the header's branch must land on the shipped checkpoint root
 *      — this header is the one at this height on the chain we anchor to.
 *
 * What it does NOT prove is burial depth. Confirmations need every header
 * from the block to the tip and their work, which is a different job; they
 * remain the server's word and are labelled so.
 *
 * Three outcomes, and the middle one is deliberately not an error: a mark
 * newer than the checkpoint, or a server that cannot produce proofs, is not a
 * bad mark. It falls back to disclosure, with the reason stated.
 */

import { bytesToHex, hexToBytes } from "@hashmark/protocol";

import type { RadiantChain } from "./chain";
import { HEADER_CHECKPOINT } from "./checkpoint";
import { parseHeader } from "./header";
import { bytesEqual, merkleRootFromBranch, reverseBytes } from "./merkle";

export type InclusionResult =
  | {
      readonly kind: "proved";
      readonly height: number;
      /** Block time from the proved header, Unix seconds. */
      readonly blockTime: number;
      /** Block hash, display order. */
      readonly blockHash: string;
      readonly checkpointHeight: number;
    }
  | {
      /** Could not prove — the server's word stands, and is labelled so. */
      readonly kind: "unproved";
      readonly reason: "ABOVE_CHECKPOINT" | "UNCONFIRMED" | "PROOF_UNAVAILABLE";
      readonly detail: string;
    }
  | {
      /**
       * A proof was produced and is WRONG. Not a fallback: a server handed
       * over branches that do not reconcile, which is either a bug or a lie,
       * and the mark must not be presented as confirmed in that block.
       */
      readonly kind: "contradicted";
      readonly detail: string;
    };

const displayToInternal = (hex: string) => reverseBytes(hexToBytes(hex)!);

/**
 * Check a set of proofs against the anchor. Pure: no network, so the pinned
 * fixture can exercise every branch of it.
 */
export function checkInclusion(input: {
  txid: string;
  height: number;
  position: number;
  txBranch: readonly string[];
  headerHex: string;
  headerBranch: readonly string[];
  checkpoint?: { height: number; root: string };
}): InclusionResult {
  const checkpoint = input.checkpoint ?? HEADER_CHECKPOINT;

  const headerBytes = hexToBytes(input.headerHex);
  const header = headerBytes ? parseHeader(headerBytes) : undefined;
  if (!header) {
    return { kind: "contradicted", detail: "the server's block header is not 80 bytes" };
  }

  let txRoot: Uint8Array;
  let headerRoot: Uint8Array;
  try {
    txRoot = merkleRootFromBranch(
      displayToInternal(input.txid),
      input.txBranch.map(displayToInternal),
      input.position,
    );
    headerRoot = merkleRootFromBranch(
      header.hash,
      input.headerBranch.map(displayToInternal),
      input.height,
    );
  } catch (error) {
    return {
      kind: "contradicted",
      detail: error instanceof Error ? error.message : "malformed branch",
    };
  }

  if (!bytesEqual(txRoot, header.merkleRoot)) {
    return {
      kind: "contradicted",
      detail: "the transaction's branch does not lead to this block's merkle root",
    };
  }
  if (bytesToHex(reverseBytes(headerRoot)) !== checkpoint.root) {
    return {
      kind: "contradicted",
      detail: "this block header does not belong to the chain the checkpoint anchors",
    };
  }

  return {
    kind: "proved",
    height: input.height,
    blockTime: header.time,
    blockHash: bytesToHex(reverseBytes(header.hash)),
    checkpointHeight: checkpoint.height,
  };
}

/**
 * Fetch the proofs for a confirmed transaction and check them.
 *
 * The height comes from the server's own confirmation count, which is not
 * circular: the proof certifies whatever height it is asked about, so a lie
 * about the height produces a proof that fails rather than one that passes.
 */
export async function proveInclusion(
  chain: RadiantChain,
  txid: string,
  confirmations: number,
): Promise<InclusionResult> {
  if (confirmations <= 0) {
    return {
      kind: "unproved",
      reason: "UNCONFIRMED",
      detail: "not yet in a block, so there is nothing to prove",
    };
  }

  let tipHeight: number;
  try {
    tipHeight = await chain.tipHeight();
  } catch {
    return {
      kind: "unproved",
      reason: "PROOF_UNAVAILABLE",
      detail: "the server did not report its tip",
    };
  }
  const height = tipHeight - confirmations + 1;

  if (height > HEADER_CHECKPOINT.height) {
    return {
      kind: "unproved",
      reason: "ABOVE_CHECKPOINT",
      detail: `block ${height.toLocaleString()} is newer than this build's checkpoint at ${HEADER_CHECKPOINT.height.toLocaleString()}`,
    };
  }

  try {
    const [merkle, headerProof] = await Promise.all([
      chain.getMerkleProof(txid, height),
      chain.getBlockHeaderProof(height, HEADER_CHECKPOINT.height),
    ]);
    return checkInclusion({
      txid,
      height,
      position: merkle.position,
      txBranch: merkle.branchHex,
      headerHex: headerProof.headerHex,
      headerBranch: headerProof.branchHex,
    });
  } catch {
    // Unreachable, unsupported, or a height the server has no proof for.
    // None of those say anything about the mark.
    return {
      kind: "unproved",
      reason: "PROOF_UNAVAILABLE",
      detail: "the server could not supply inclusion proofs",
    };
  }
}
