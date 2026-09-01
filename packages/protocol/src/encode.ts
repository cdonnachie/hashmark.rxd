/**
 * HashMark record encoder.
 *
 * The encoder is strict on the way in so the decoder can be strict on the way
 * out: anything it would refuse to read, this refuses to write. Every input
 * that cannot produce a canonical record throws, rather than being silently
 * trimmed or coerced — a label quietly truncated mid-character would be
 * written to the chain permanently.
 */

import { concatBytes, hexToBytes, labelDefect, utf8ToBytes } from "./bytes";
import {
  MAGIC,
  MAX_LABEL_BYTES,
  MAX_LABEL_BYTES_V1,
  MAX_SCRIPT_BYTES,
  PROTOCOL_VERSION,
  SIGNATURE_BYTES,
  SIGNER_HASH_BYTES,
  algorithmByName,
  maxLabelBytes,
} from "./constants";
import { OP_RETURN, encodePush } from "./script";

export interface EncodeOptions {
  /** Algorithm name, e.g. `"sha256"`. */
  readonly algorithm: string;
  /** Lowercase hex digest. Length must match the algorithm exactly. */
  readonly digest: string;
  /**
   * The committed signer: 40 lowercase hex, the hash160 a P2PKH address
   * encodes. Verification requires the signature to recover to exactly this.
   */
  readonly signerHash160: string;
  /**
   * 130 lowercase hex — the 65-byte compact recoverable signature over
   * {@link canonicalAttestationMessage} for this record.
   *
   * Produced by the signer's wallet, never by this package: HashMark holds no
   * keys. The caller must have already checked that it recovers to
   * `signerHash160`, because this encoder cannot (it has no secp256k1).
   */
  readonly signature: string;
  /**
   * Optional public label. Permanently public once broadcast.
   *
   * Normalized to Unicode NFC before measurement, so the byte length written
   * on-chain is the length that was validated — two visually identical labels
   * cannot encode to different lengths depending on how the text was typed.
   */
  readonly label?: string | undefined;
}

export class HashMarkEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HashMarkEncodeError";
  }
}

/**
 * Normalize and validate a label exactly as {@link encodeHashMarkScript} will.
 *
 * Exposed separately so the UI can show a live byte count and the real reason
 * a label is rejected, without building a script or catching an exception.
 */
export function prepareLabel(
  label: string,
  maxBytes: number = MAX_LABEL_BYTES,
): {
  readonly normalized: string;
  readonly bytes: Uint8Array;
} {
  // Canonicalisation runs one way: trim and normalize here, at creation, then
  // sign and encode exactly this. A decoder never does the reverse — it rejects
  // a non-canonical label rather than repairing one, or it would be verifying a
  // signature over a string the chain does not contain.
  const normalized = label.trim().normalize("NFC");
  if (normalized.length === 0) {
    throw new HashMarkEncodeError(
      "label is empty; omit it entirely rather than encoding an empty push",
    );
  }
  const defect = labelDefect(normalized);
  if (defect !== undefined) {
    throw new HashMarkEncodeError(
      defect === "CONTROL_CHARS"
        ? "label contains control characters"
        : defect === "BIDI"
          ? "label contains characters that can hide or reorder text"
          : "label is not canonical after trimming and normalization",
    );
  }
  const bytes = utf8ToBytes(normalized);
  if (bytes.length > maxBytes) {
    throw new HashMarkEncodeError(
      `label is ${bytes.length} UTF-8 bytes, over the ${maxBytes}-byte limit`,
    );
  }
  return { normalized, bytes };
}

/** Byte length of the label as it would be written on-chain, for live UI counts. */
export function labelByteLength(label: string): number {
  return utf8ToBytes(label.normalize("NFC")).length;
}

/**
 * Build the complete `scriptPubKey` for a HashMark output.
 *
 * The caller places this in a transaction output carrying **zero** photons.
 */
export function encodeHashMarkScript(options: EncodeOptions): Uint8Array {
  const algorithm = algorithmByName(options.algorithm);
  if (algorithm === undefined) {
    throw new HashMarkEncodeError(
      `unsupported hash algorithm "${options.algorithm}"`,
    );
  }

  const digest = hexToBytes(options.digest);
  if (digest === undefined) {
    throw new HashMarkEncodeError(
      "digest must be lowercase hexadecimal with an even length",
    );
  }
  if (digest.length !== algorithm.digestLength) {
    throw new HashMarkEncodeError(
      `${algorithm.name} digest must be ${algorithm.digestLength} bytes, got ${digest.length}`,
    );
  }

  const signer = hexToBytes(options.signerHash160);
  if (signer === undefined || signer.length !== SIGNER_HASH_BYTES) {
    throw new HashMarkEncodeError(
      `signerHash160 must be ${SIGNER_HASH_BYTES} bytes of lowercase hex`,
    );
  }

  const signature = hexToBytes(options.signature);
  if (signature === undefined || signature.length !== SIGNATURE_BYTES) {
    throw new HashMarkEncodeError(
      `signature must be ${SIGNATURE_BYTES} bytes of lowercase hex`,
    );
  }

  const parts: Uint8Array[] = [
    Uint8Array.of(OP_RETURN),
    encodePush(MAGIC),
    encodePush(Uint8Array.of(PROTOCOL_VERSION, algorithm.id)),
    encodePush(digest),
    encodePush(signer),
    encodePush(signature),
  ];

  if (options.label !== undefined && options.label !== "") {
    parts.push(
      encodePush(
        prepareLabel(options.label, maxLabelBytes(algorithm.digestLength)).bytes,
      ),
    );
  }

  const script = concatBytes(...parts);

  // Unreachable while the label cap is derived from the same budget, but kept
  // so a future field can never silently push a record past the conservative
  // relay limit.
  if (script.length > MAX_SCRIPT_BYTES) {
    throw new HashMarkEncodeError(
      `record is ${script.length} bytes, over the ${MAX_SCRIPT_BYTES}-byte relay budget`,
    );
  }

  return script;
}

/**
 * Write a **v1** record: digest and label, no signer and no signature.
 *
 * v1 is no longer the format this project produces — a v1 record cannot say
 * who made it (docs/HASHMARK_V2_ATTESTATION.md §1). This exists so tests and
 * tooling can still build the records that already exist on chain, and so the
 * decoder's v1 path has something to exercise it. Do not use it to make new
 * marks.
 */
export function encodeLegacyV1Script(options: {
  readonly algorithm: string;
  readonly digest: string;
  readonly label?: string | undefined;
}): Uint8Array {
  const algorithm = algorithmByName(options.algorithm);
  if (algorithm === undefined) {
    throw new HashMarkEncodeError(
      `unsupported hash algorithm "${options.algorithm}"`,
    );
  }
  const digest = hexToBytes(options.digest);
  if (digest === undefined || digest.length !== algorithm.digestLength) {
    throw new HashMarkEncodeError(
      `${algorithm.name} digest must be ${algorithm.digestLength} bytes of lowercase hex`,
    );
  }

  const parts: Uint8Array[] = [
    Uint8Array.of(OP_RETURN),
    encodePush(MAGIC),
    encodePush(Uint8Array.of(1, algorithm.id)),
    encodePush(digest),
  ];
  if (options.label !== undefined && options.label !== "") {
    parts.push(encodePush(prepareLabel(options.label, MAX_LABEL_BYTES_V1).bytes));
  }
  return concatBytes(...parts);
}
