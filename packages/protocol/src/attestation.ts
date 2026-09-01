/**
 * The statement a v2 record is a signature over.
 *
 * Kept in this package, and free of dependencies, because an independent
 * verifier needs to rebuild this string byte-for-byte to check anything. The
 * recovery and comparison that follow need secp256k1 and live in the
 * application; this half does not, and should stay portable.
 *
 * See docs/HASHMARK_V2_ATTESTATION.md sections 3 and 5.
 */

import { labelDefect } from "./bytes";
import { algorithmById } from "./constants";

export interface AttestationStatement {
  /**
   * Genesis hash of the chain the record was found on, in RPC/display byte
   * order, 64 lowercase hex.
   *
   * Not carried by the record: it is the verified context the transaction was
   * fetched from. The same bytes on another chain make a different statement,
   * and the signature will not verify there - which is the point.
   */
  readonly genesisHash: string;
  /** The record's committed signer, 40 lowercase hex. */
  readonly signerHash160: string;
  /** The record's algorithm id, signed as the byte it is - never as a name. */
  readonly algorithmId: number;
  /** Lowercase hex digest. */
  readonly digest: string;
  /** The canonical label, omitted entirely when the record carries none. */
  readonly label?: string | undefined;
}

export class AttestationMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationMessageError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * JSON string escaping, fixed by this protocol rather than borrowed.
 *
 * Only the two characters JSON cannot represent literally are escaped, and
 * everything else is emitted as raw UTF-8 - never as a \uXXXX sequence. Control
 * characters cannot appear: labels reject them and every other field is hex.
 * `JSON.stringify` would produce the same output today for every input this
 * protocol permits, but its treatment of edge cases is a property of the engine,
 * and a signature must not depend on that.
 */
function jsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else out += ch;
  }
  return out + '"';
}

/**
 * Build the exact string a v2 signature covers.
 *
 * Single line, fixed key order, no insignificant whitespace. Single-line
 * because a wallet may refuse to sign a message containing control characters -
 * Photonic does - and a newline is one.
 */
export function canonicalAttestationMessage(
  statement: AttestationStatement,
): string {
  if (!HEX64.test(statement.genesisHash)) {
    throw new AttestationMessageError(
      "genesisHash must be 64 lowercase hex characters; a network whose genesis hash is unknown cannot be attested to",
    );
  }
  if (!HEX40.test(statement.signerHash160)) {
    throw new AttestationMessageError(
      "signerHash160 must be 40 lowercase hex characters",
    );
  }
  const algorithm = algorithmById(statement.algorithmId);
  if (algorithm === undefined) {
    throw new AttestationMessageError(
      `unknown algorithm id ${statement.algorithmId}`,
    );
  }
  if (!HEX.test(statement.digest) || statement.digest.length !== algorithm.digestLength * 2) {
    throw new AttestationMessageError(
      `digest must be ${algorithm.digestLength} bytes of lowercase hex`,
    );
  }
  if (statement.label !== undefined) {
    if (statement.label === "") {
      throw new AttestationMessageError(
        "an empty label is not encodable; omit it instead",
      );
    }
    const defect = labelDefect(statement.label);
    if (defect !== undefined) {
      throw new AttestationMessageError(`label is not canonical: ${defect}`);
    }
  }

  const fields: string[] = [
    '"v":"HashMark/v2"',
    '"network":' + jsonString(statement.genesisHash),
    '"signerHash160":' + jsonString(statement.signerHash160),
    '"algorithmId":' +
      jsonString(statement.algorithmId.toString(16).padStart(2, "0")),
    '"digest":' + jsonString(statement.digest),
  ];
  if (statement.label !== undefined) {
    fields.push('"label":' + jsonString(statement.label));
  }

  return "{" + fields.join(",") + "}";
}
