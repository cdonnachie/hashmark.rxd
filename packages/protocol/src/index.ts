/**
 * @hashmark/protocol — the HashMark on-chain format and receipt schema.
 *
 * Framework-independent and dependency-free by design: a third-party verifier
 * should be able to depend on this package alone, in a browser or in Node,
 * without pulling in a Radiant library or a web framework.
 *
 * See HASHMARK_PROTOCOL.md for the byte layout, validation rules and
 * instructions for implementing a verifier from scratch.
 */

export {
  bytesEqual,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hasControlChars,
  hexToBytes,
  labelDefect,
  utf8ToBytes,
} from "./bytes";
export type { LabelDefect } from "./bytes";

export {
  MAX_PUSH_BYTES,
  OP_RETURN,
  encodePush,
  encodedPushSize,
  readPushes,
} from "./script";

export {
  MAGIC,
  MAGIC_TEXT,
  MAX_LABEL_BYTES,
  MAX_LABEL_BYTES_V1,
  MAX_SCRIPT_BYTES,
  PROTOCOL_VERSION,
  SHA256,
  SIGNATURE_BYTES,
  SIGNER_HASH_BYTES,
  SUPPORTED_VERSIONS,
  algorithmById,
  algorithmByName,
  maxLabelBytes,
  supportedAlgorithms,
} from "./constants";
export type { HashAlgorithm } from "./constants";

export {
  HashMarkEncodeError,
  encodeHashMarkScript,
  encodeLegacyV1Script,
  labelByteLength,
  prepareLabel,
} from "./encode";
export {
  AttestationMessageError,
  canonicalAttestationMessage,
} from "./attestation";
export type { AttestationStatement } from "./attestation";
export type { EncodeOptions } from "./encode";

export { decodeHashMarkScript } from "./decode";
export type {
  DecodeFailureReason,
  DecodeResult,
  HashMarkRecord,
} from "./decode";

export {
  MAX_RECEIPT_BYTES,
  RADIANT_MAINNET,
  RADIANT_TESTNET,
  RECEIPT_FORMAT,
  RECEIPT_VERSION,
  buildReceipt,
  networkById,
  parseReceipt,
  serializeReceipt,
  validateReceipt,
} from "./receipt";
export type {
  HashMarkReceipt,
  NetworkInfo,
  ReceiptValidation,
} from "./receipt";
