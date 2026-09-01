/**
 * Verifying a v2 attestation.
 *
 * Separate from `@hashmark/protocol` because this half needs secp256k1 and the
 * chain's genesis hash, and that package is deliberately dependency-free so a
 * third party can read records without either. Decoding says a record is
 * well-formed; this says whether its claim holds.
 *
 * The check that matters is step 5 of docs/HASHMARK_V2_ATTESTATION.md §5:
 * **the recovered key must hash to the signer the record committed to**.
 * Recovering a key and then verifying against that same key proves nothing —
 * for any chosen `R` and `s`, recovery yields a `Q` under which the signature
 * verifies by construction, with no private key involved. The commitment is
 * what turns recovery into a test something can fail.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  canonicalAttestationMessage,
  hexToBytes,
  type HashMarkRecord,
} from "@hashmark/protocol";

import { encodeRadiantAddress, hash160 } from "./address";
import { magicHash, RADIANT_MESSAGE_PREFIX } from "./signmessage";

export type AttestationFailure =
  /** A v1 record. Not a failure of anything — it predates signed attestations. */
  | "UNSIGNED"
  /** The signature is not a canonical 65-byte compact recoverable signature. */
  | "MALFORMED_SIGNATURE"
  /** No public key could be recovered from it. */
  | "UNRECOVERABLE"
  /** A key was recovered, but it is not the one the record committed to. */
  | "SIGNER_MISMATCH"
  /** The statement itself could not be built — e.g. an unknown genesis hash. */
  | "UNVERIFIABLE_CONTEXT";

export type AttestationResult =
  | {
      readonly ok: true;
      /** The committed signer, as an address. Encoded from the record's own
       * bytes, never from the recovered key. */
      readonly signer: string;
      /** The exact string the signature covers. Useful for diagnostics. */
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: AttestationFailure;
      readonly detail: string;
    };

/** Order of the secp256k1 group, for the low-S check. */
const N = secp256k1.Point.Fn.ORDER;
const HALF_N = N >> 1n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Check a v2 record's signature against the signer it commits to.
 *
 * `genesisHash` is the chain the transaction was actually found on — not a
 * value from the record, and not one a caller may assert casually. The same
 * record bytes on another chain make a different statement and will not verify,
 * which is exactly the intent.
 */
export function verifyAttestation(
  record: HashMarkRecord,
  genesisHash: string,
): AttestationResult {
  if (record.version !== 2 || record.signature === undefined) {
    return {
      ok: false,
      reason: "UNSIGNED",
      detail: "this record carries no attestation signature",
    };
  }
  if (record.signerHash160 === undefined) {
    return {
      ok: false,
      reason: "MALFORMED_SIGNATURE",
      detail: "a v2 record must commit to a signer",
    };
  }

  let message: string;
  try {
    message = canonicalAttestationMessage({
      genesisHash,
      signerHash160: record.signerHash160,
      algorithmId: record.algorithmId,
      digest: record.digest,
      label: record.label,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "UNVERIFIABLE_CONTEXT",
      detail:
        error instanceof Error ? error.message : "could not build the statement",
    };
  }

  const signature = hexToBytes(record.signature);
  if (signature === undefined || signature.length !== 65) {
    return {
      ok: false,
      reason: "MALFORMED_SIGNATURE",
      detail: "signature must be 65 bytes",
    };
  }

  const header = signature[0]!;
  if (header < 27 || header > 34) {
    return {
      ok: false,
      reason: "MALFORMED_SIGNATURE",
      detail: `signature header ${header} is outside 27..34`,
    };
  }
  const recoveryId = (header - 27) & 3;
  const compressed = header >= 31;

  const r = bytesToBigInt(signature.subarray(1, 33));
  const s = bytesToBigInt(signature.subarray(33, 65));
  if (r <= 0n || r >= N) {
    return { ok: false, reason: "MALFORMED_SIGNATURE", detail: "r out of range" };
  }
  if (s <= 0n || s > HALF_N) {
    // Low-S is required so a signature has one accepted form. It does not make
    // signatures unique — a different nonce gives different bytes — which is
    // why an attestation is identified by its statement and signer, never by
    // these bytes.
    return {
      ok: false,
      reason: "MALFORMED_SIGNATURE",
      detail: "s is zero or not canonical (low-S required)",
    };
  }

  let recovered: Uint8Array;
  try {
    recovered = secp256k1.Signature.fromBytes(signature.subarray(1), "compact")
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(magicHash(message, RADIANT_MESSAGE_PREFIX))
      .toBytes(compressed);
  } catch {
    return {
      ok: false,
      reason: "UNRECOVERABLE",
      detail: "no public key could be recovered from this signature",
    };
  }

  const committed = hexToBytes(record.signerHash160);
  if (committed === undefined || committed.length !== 20) {
    return {
      ok: false,
      reason: "MALFORMED_SIGNATURE",
      detail: "committed signer is not 20 bytes",
    };
  }

  const derived = hash160(recovered);
  for (let i = 0; i < 20; i++) {
    if (derived[i] !== committed[i]) {
      return {
        ok: false,
        reason: "SIGNER_MISMATCH",
        detail:
          "the signature does not belong to the signer this record commits to",
      };
    }
  }

  return { ok: true, signer: encodeRadiantAddress(committed), message };
}
