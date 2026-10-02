/**
 * The 80-byte block header, read just far enough to verify a mark.
 *
 * Radiant kept Bitcoin's header layout. Only two fields matter to a proof —
 * the transaction merkle root, which the tx branch must land on, and the
 * timestamp, which becomes the authentic "no later than" once the header
 * itself is proved — but the rest is parsed so a wrong-sized or garbled
 * header fails loudly here instead of as a baffling root mismatch later.
 */

import { sha512_256 } from "@noble/hashes/sha2.js";

export const HEADER_BYTES = 80;

export interface BlockHeader {
  readonly version: number;
  /** Previous block hash, internal order. */
  readonly prevHash: Uint8Array;
  /** Transaction merkle root, internal order. */
  readonly merkleRoot: Uint8Array;
  /** Miner-set timestamp, Unix seconds. All of §8's caveats apply. */
  readonly time: number;
  readonly bits: number;
  readonly nonce: number;
  /**
   * The block hash, internal order: **double SHA-512/256**, not double SHA-256.
   *
   * Radiant diverges from Bitcoin here (ElectrumX's Radiant coin class,
   * `header_hash` = `double_sha512_256`). The header *tree* still pairs its
   * nodes with double SHA-256 — only the leaves differ — so getting this wrong
   * produces a branch that is internally consistent and lands on the wrong
   * root, which is exactly how it was found.
   */
  readonly hash: Uint8Array;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    ((bytes[offset + 3]! << 24) >>> 0)
  ) >>> 0;
}

/** Parse an 80-byte header, or return undefined for anything else. */
export function parseHeader(bytes: Uint8Array): BlockHeader | undefined {
  if (bytes.length !== HEADER_BYTES) return undefined;
  return {
    version: readUint32LE(bytes, 0),
    prevHash: bytes.slice(4, 36),
    merkleRoot: bytes.slice(36, 68),
    time: readUint32LE(bytes, 68),
    bits: readUint32LE(bytes, 72),
    nonce: readUint32LE(bytes, 76),
    hash: sha512_256(sha512_256(bytes)),
  };
}
