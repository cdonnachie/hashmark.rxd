/**
 * HashMark record decoder.
 *
 * Two rules govern everything here:
 *
 *  1. **Never guess.** A record either decodes exactly, or it produces a
 *     typed failure. There is no partial or best-effort result, because a
 *     half-read record shown to a user as a timestamp is worse than no result.
 *
 *  2. **"Not a HashMark" is not "broken".** Most `OP_RETURN` outputs on
 *     Radiant belong to other protocols. Those get `NOT_HASHMARK`, which a
 *     caller scanning a block should skip silently — distinct from `INVALID`,
 *     which means something claimed to be a HashMark and was malformed.
 */

import {
  bytesEqual,
  bytesToHex,
  bytesToUtf8,
  labelDefect,
  type LabelDefect,
} from "./bytes";
import {
  MAGIC,
  MAX_LABEL_BYTES_V1,
  SIGNATURE_BYTES,
  SIGNER_HASH_BYTES,
  SUPPORTED_VERSIONS,
  algorithmById,
  maxLabelBytes,
} from "./constants";
import { OP_RETURN, readPushes } from "./script";

export interface HashMarkRecord {
  readonly version: number;
  /** On-chain algorithm id. */
  readonly algorithmId: number;
  /** Resolved algorithm name, e.g. `"sha256"`. */
  readonly algorithm: string;
  /** Lowercase hex, always exactly the algorithm's digest length. */
  readonly digest: string;
  /** The optional public label, or undefined when the record carries none. */
  readonly label?: string;
  /**
   * Why a label the record *does* carry is not being returned in `label`.
   *
   * Only ever set for v1 records. A v1 label is not signed and forms no part of
   * any claim, so an unsafe one can misrepresent itself on screen but cannot
   * misrepresent a statement — withholding it costs nothing, while rejecting
   * the record would throw away timestamp evidence over a rendering problem.
   * In v2 the label is signed, so the same defect makes the record INVALID.
   */
  readonly labelWithheld?: LabelDefect;
  /** v2 only: the committed signer, 40 lowercase hex. */
  readonly signerHash160?: string;
  /** v2 only: the 65-byte compact recoverable signature, lowercase hex. */
  readonly signature?: string;
}

export type DecodeFailureReason =
  /** Not a HashMark output at all. Skip it; this is not an error. */
  | "NOT_HASHMARK"
  /** Claims to be a HashMark, but the structure is wrong. */
  | "INVALID"
  /** A HashMark of a protocol version this decoder does not implement. */
  | "UNKNOWN_VERSION"
  /** A HashMark using a hash algorithm this decoder does not know. */
  | "UNKNOWN_ALGORITHM";

export type DecodeResult =
  | { readonly ok: true; readonly record: HashMarkRecord }
  | {
      readonly ok: false;
      readonly reason: DecodeFailureReason;
      /** Human-readable detail. Safe to log; never contains file content. */
      readonly detail: string;
      /** Present for UNKNOWN_VERSION: the version actually observed. */
      readonly observedVersion?: number;
      /** Present for UNKNOWN_ALGORITHM: the algorithm id actually observed. */
      readonly observedAlgorithmId?: number;
    };

function fail(
  reason: DecodeFailureReason,
  detail: string,
  extra?: { observedVersion?: number; observedAlgorithmId?: number },
): DecodeResult {
  return { ok: false, reason, detail, ...extra };
}

/**
 * Decode a `scriptPubKey` into a HashMark record.
 *
 * Expected layout (see HASHMARK_PROTOCOL.md):
 *
 *     OP_RETURN
 *       <push 8>  "HASHMARK"
 *       <push 2>  version ‖ algorithmId
 *       <push N>  digest, N fixed by algorithmId
 *       <push 20> signerHash160    v2 only
 *       <push 65> signature        v2 only
 *       <push L>  label, optional
 *
 * The signature is NOT checked here. This module is dependency-free and knows
 * nothing of secp256k1 or of which chain a record was found on, and both are
 * needed to verify an attestation — see `verifyAttestation` in the application.
 * A record that decodes is well-formed, not yet believed.
 */
export function decodeHashMarkScript(script: Uint8Array): DecodeResult {
  if (script.length === 0 || script[0] !== OP_RETURN) {
    return fail("NOT_HASHMARK", "output is not an OP_RETURN data output");
  }

  const pushes = readPushes(script, 1);
  if (pushes === undefined) {
    // Could be another protocol using non-minimal or non-push encoding, so
    // this stays NOT_HASHMARK: we have not yet seen a magic to claim otherwise.
    return fail(
      "NOT_HASHMARK",
      "OP_RETURN payload is not a sequence of minimally-encoded data pushes",
    );
  }

  const magic = pushes[0];
  if (magic === undefined || !bytesEqual(magic, MAGIC)) {
    return fail("NOT_HASHMARK", "first push is not the HASHMARK magic");
  }

  // From here on the output claims to be a HashMark, so every remaining
  // failure is a real defect rather than someone else's protocol.

  // Push count depends on the version, which is inside the header, so the
  // shape can only be checked once the header has been read.
  if (pushes.length < 3) {
    return fail("INVALID", `expected at least 3 pushes, found ${pushes.length}`);
  }

  const header = pushes[1];
  if (header === undefined || header.length !== 2) {
    return fail(
      "INVALID",
      `header push must be exactly 2 bytes, found ${header?.length ?? 0}`,
    );
  }

  const version = header[0] as number;
  const algorithmId = header[1] as number;

  if (!SUPPORTED_VERSIONS.includes(version)) {
    // Deliberately reported before the algorithm is examined: a later version
    // may redefine every field after the header, so nothing beyond it can be
    // trusted to mean what it means here. A record from the future is not
    // corrupt, and must never be reported as malformed.
    return fail(
      "UNKNOWN_VERSION",
      `unsupported protocol version ${version}`,
      { observedVersion: version },
    );
  }

  const algorithm = algorithmById(algorithmId);
  if (algorithm === undefined) {
    return fail(
      "UNKNOWN_ALGORITHM",
      `unsupported hash algorithm id ${algorithmId}`,
      { observedAlgorithmId: algorithmId },
    );
  }

  const digest = pushes[2];
  if (digest === undefined || digest.length !== algorithm.digestLength) {
    return fail(
      "INVALID",
      `${algorithm.name} digest must be ${algorithm.digestLength} bytes, found ${digest?.length ?? 0}`,
    );
  }

  // Version-specific tail. v1 stops at the label; v2 carries the committed
  // signer and its signature first.
  const expectedPushes = version === 1 ? [3, 4] : [5, 6];
  if (!expectedPushes.includes(pushes.length)) {
    return fail(
      "INVALID",
      `a v${version} record has ${expectedPushes.join(" or ")} pushes, found ${pushes.length}`,
    );
  }

  let signerHash160: string | undefined;
  let signature: string | undefined;

  if (version === 2) {
    const signer = pushes[3];
    if (signer === undefined || signer.length !== SIGNER_HASH_BYTES) {
      return fail(
        "INVALID",
        `committed signer must be ${SIGNER_HASH_BYTES} bytes, found ${signer?.length ?? 0}`,
      );
    }
    const sig = pushes[4];
    if (sig === undefined || sig.length !== SIGNATURE_BYTES) {
      return fail(
        "INVALID",
        `signature must be ${SIGNATURE_BYTES} bytes, found ${sig?.length ?? 0}`,
      );
    }
    signerHash160 = bytesToHex(signer);
    signature = bytesToHex(sig);
  }

  const labelBytes = pushes[version === 1 ? 3 : 5];
  const labelCap =
    version === 1 ? MAX_LABEL_BYTES_V1 : maxLabelBytes(algorithm.digestLength);

  let label: string | undefined;
  let labelWithheld: LabelDefect | undefined;

  if (labelBytes !== undefined) {
    if (labelBytes.length > labelCap) {
      return fail(
        "INVALID",
        `label exceeds ${labelCap} bytes (found ${labelBytes.length})`,
      );
    }
    const text = bytesToUtf8(labelBytes);
    if (text === undefined) {
      // Invalid UTF-8 is malformed at any version: there is no string to
      // withhold, only bytes that do not decode.
      return fail("INVALID", "label is not valid UTF-8");
    }

    const defect = labelDefect(text);
    if (defect === undefined) {
      label = text;
    } else if (version === 1) {
      // Keep the record, drop the label. A v1 label is not signed, so a
      // dangerous one costs the reader a caption, not the timestamp.
      labelWithheld = defect;
    } else {
      // In v2 the label is part of the signed statement. A label that is not
      // canonical is not the label that was signed.
      return fail("INVALID", `label is not canonical: ${defect}`);
    }
  }

  return {
    ok: true,
    record: {
      version,
      algorithmId,
      algorithm: algorithm.name,
      digest: bytesToHex(digest),
      ...(label === undefined ? {} : { label }),
      ...(labelWithheld === undefined ? {} : { labelWithheld }),
      ...(signerHash160 === undefined ? {} : { signerHash160 }),
      ...(signature === undefined ? {} : { signature }),
    },
  };
}
