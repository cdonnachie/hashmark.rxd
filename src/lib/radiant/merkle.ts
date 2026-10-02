/**
 * Merkle branch verification, shared by both proofs.
 *
 * ElectrumX uses one tree construction twice: over a block's transactions
 * (`blockchain.transaction.get_merkle`) and over the chain's headers
 * (`blockchain.block.header` with `cp_height`). Both are double-SHA256,
 * paired left-right, with an odd count duplicating the final hash — so one
 * routine verifies either, and a fix to one cannot drift from the other.
 *
 * Byte order is the entire difficulty. Every hash crosses the wire as hex in
 * display order (reversed); every hash is *hashed* in internal order. The
 * convention here: this module speaks internal bytes only, and callers do the
 * reversing at the wire boundary, in exactly one place each.
 */

import { sha256 } from "@noble/hashes/sha2.js";

function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Walk a branch from `leaf` (internal order) at position `index`, returning
 * the root it lands on (internal order).
 *
 * The index's low bit decides each pairing side: even means the leaf is the
 * left node, odd the right — the mirror of how the server built the branch
 * (`hashes[index ^ 1]` at every level, then `index >>= 1`).
 */
export function merkleRootFromBranch(
  leaf: Uint8Array,
  branch: readonly Uint8Array[],
  index: number,
): Uint8Array {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError("merkle index must be a non-negative integer");
  }
  // A branch longer than 64 cannot describe any real tree and would only
  // happen if a server is feeding us garbage; stop rather than loop on it.
  if (branch.length > 64) {
    throw new RangeError("merkle branch is implausibly long");
  }

  let hash = leaf;
  let position = index;

  for (const sibling of branch) {
    if (sibling.length !== 32) {
      throw new RangeError("merkle branch elements must be 32 bytes");
    }
    const combined = new Uint8Array(64);
    if (position & 1) {
      combined.set(sibling, 0);
      combined.set(hash, 32);
    } else {
      combined.set(hash, 0);
      combined.set(sibling, 32);
    }
    hash = sha256d(combined);
    position >>= 1;
  }

  // If position is still non-zero, the index needed more levels than the
  // branch supplied: the proof cannot be about this position.
  if (position !== 0) {
    throw new RangeError("merkle branch is too short for this index");
  }

  return hash;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Reverse a copy — display order to internal order and back. */
export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out.reverse();
  return out;
}
