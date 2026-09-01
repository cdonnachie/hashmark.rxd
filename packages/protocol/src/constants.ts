/**
 * HashMark protocol constants and the hash-algorithm registry.
 *
 * Adding an algorithm is the only expected reason to touch this file. Doing so
 * does *not* need a protocol version bump: the algorithm id is a field, so an
 * old decoder meeting a new algorithm reports `UNKNOWN_ALGORITHM` and stops,
 * rather than misreading the digest at the wrong width.
 */

import { utf8ToBytes } from "./bytes";
import { encodedPushSize } from "./script";

/** ASCII `HASHMARK`, the first push of every record. */
export const MAGIC = utf8ToBytes("HASHMARK");
export const MAGIC_TEXT = "HASHMARK";

/**
 * The version this package **writes**. v2 records carry a signed attestation.
 */
export const PROTOCOL_VERSION = 2;

/** Versions this package can read. v1 records stay valid forever. */
export const SUPPORTED_VERSIONS: readonly number[] = [1, 2];

/** Bytes of committed signer hash (a P2PKH hash160) in a v2 record. */
export const SIGNER_HASH_BYTES = 20;

/**
 * Bytes of compact recoverable signature in a v2 record: one header byte, then
 * `r` and `s` as 32 bytes each, big-endian.
 */
export const SIGNATURE_BYTES = 65;

/**
 * Label cap for **v1** records, which carry no signature and so had 40 more
 * bytes of budget to spend. Reading a v1 record still honours it.
 */
export const MAX_LABEL_BYTES_V1 = 128;

/**
 * Self-imposed cap on the whole `scriptPubKey`.
 *
 * Radiant Core's own default is far higher (`DEFAULT_DATACARRIER_BYTES` =
 * 1024), but `MAX_OP_RETURN_RELAY` = 223 is also defined in the same header and
 * an operator may configure `-datacarriersize` down to it. Staying under 223
 * means a HashMark relays on either setting. Our largest possible record is 176
 * bytes, so this is headroom, not a constraint we design against.
 */
export const MAX_SCRIPT_BYTES = 223;

export interface HashAlgorithm {
  /** On-chain identifier. Stable forever once assigned. */
  readonly id: number;
  /** Lowercase name used in receipts and the UI. */
  readonly name: string;
  /** Exact digest length in bytes. A record whose digest differs is invalid. */
  readonly digestLength: number;
}

export const SHA256: HashAlgorithm = {
  id: 0x01,
  name: "sha256",
  digestLength: 32,
};

const ALGORITHMS: readonly HashAlgorithm[] = [SHA256];

export function algorithmById(id: number): HashAlgorithm | undefined {
  return ALGORITHMS.find((algorithm) => algorithm.id === id);
}

export function algorithmByName(name: string): HashAlgorithm | undefined {
  return ALGORITHMS.find((algorithm) => algorithm.name === name);
}

export function supportedAlgorithms(): readonly HashAlgorithm[] {
  return ALGORITHMS;
}

/**
 * The largest label a v2 record can carry for a given digest length.
 *
 * Derived, never assumed. A v2 record spends 40 more bytes than v1 on the
 * signer hash and signature, and a future algorithm with a longer digest spends
 * more again — that has to come out of the label rather than out of the relay
 * margin, or records would quietly stop relaying on a node configured to the
 * conservative `MAX_OP_RETURN_RELAY`.
 *
 * The two-branch tail is the push prefix: one byte up to 75, two above it. A
 * label of 76 bytes therefore costs the same as one of 77, and the larger of
 * the two candidates is the real cap.
 */
export function maxLabelBytes(digestLength: number): number {
  const fixed =
    1 + // OP_RETURN
    encodedPushSize(MAGIC.length) +
    encodedPushSize(2) + // version + algorithm id
    encodedPushSize(digestLength) +
    encodedPushSize(SIGNER_HASH_BYTES) +
    encodedPushSize(SIGNATURE_BYTES);

  const budget = MAX_SCRIPT_BYTES - fixed;
  if (budget < 2) return 0;

  const direct = Math.min(budget - 1, 0x4b);
  const extended = budget - 2;
  return extended > 0x4b ? extended : direct;
}

/**
 * The label cap for a v2 sha256 record: **88 bytes**.
 *
 * Exported as the value interfaces should show, since sha256 is the only
 * algorithm v2 defines. Anything reading a v1 record wants
 * {@link MAX_LABEL_BYTES_V1} instead.
 */
export const MAX_LABEL_BYTES = maxLabelBytes(SHA256.digestLength);
