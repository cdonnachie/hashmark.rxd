/**
 * v2 records: the signed-attestation format.
 *
 * These cover the shape and the statement. Whether a signature actually
 * verifies is tested in the application, which is where secp256k1 lives -
 * this package deliberately cannot check one.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_LABEL_BYTES,
  MAX_SCRIPT_BYTES,
  canonicalAttestationMessage,
  decodeHashMarkScript,
  encodeHashMarkScript,
  encodeLegacyV1Script,
  AttestationMessageError,
  HashMarkEncodeError,
} from "../src/index";

const DIGEST =
  "e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e";
const SIGNER = "26ba056431ec69cf27eabeaab250d99ddbd895d2";
const SIGNATURE = "1f" + "ab".repeat(64);
const GENESIS =
  "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4";

function v2(label?: string) {
  return encodeHashMarkScript({
    algorithm: "sha256",
    digest: DIGEST,
    signerHash160: SIGNER,
    signature: SIGNATURE,
    ...(label === undefined ? {} : { label }),
  });
}

describe("v2 encoding", () => {
  it("round-trips through the decoder", () => {
    const result = decodeHashMarkScript(v2());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.version).toBe(2);
      expect(result.record.digest).toBe(DIGEST);
      expect(result.record.signerHash160).toBe(SIGNER);
      expect(result.record.signature).toBe(SIGNATURE);
      expect(result.record.label).toBeUndefined();
    }
  });

  it("round-trips with a label", () => {
    const result = decodeHashMarkScript(v2("Contract draft"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.label).toBe("Contract draft");
  });

  it("fits the conservative relay budget at the maximum label", () => {
    const script = v2("x".repeat(MAX_LABEL_BYTES));
    expect(MAX_LABEL_BYTES).toBe(88);
    expect(script.length).toBe(MAX_SCRIPT_BYTES);
  });

  it("refuses a label one byte over the derived cap", () => {
    expect(() => v2("x".repeat(MAX_LABEL_BYTES + 1))).toThrow(
      HashMarkEncodeError,
    );
  });

  it("refuses a signer or signature of the wrong length", () => {
    expect(() =>
      encodeHashMarkScript({
        algorithm: "sha256",
        digest: DIGEST,
        signerHash160: "ab".repeat(19),
        signature: SIGNATURE,
      }),
    ).toThrow(HashMarkEncodeError);
    expect(() =>
      encodeHashMarkScript({
        algorithm: "sha256",
        digest: DIGEST,
        signerHash160: SIGNER,
        signature: "ab".repeat(64),
      }),
    ).toThrow(HashMarkEncodeError);
  });

  it("trims a label before signing and encoding", () => {
    const result = decodeHashMarkScript(v2("  spaced  "));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.label).toBe("spaced");
  });
});

describe("v2 label rules are stricter than v1", () => {
  const bidi = "invoice\u202Efdp.exe";

  it("refuses to encode a label that can reorder its own display", () => {
    expect(() => v2(bidi)).toThrow(HashMarkEncodeError);
    expect(() => encodeLegacyV1Script({ algorithm: "sha256", digest: DIGEST, label: bidi })).toThrow(
      HashMarkEncodeError,
    );
  });

  it("rejects a v2 record carrying one, because the label is signed", () => {
    // Hand-built: the encoder would not write this.
    const good = v2("ok");
    const bytes = Array.from(good);
    // Replace the two-byte label "ok" with a two-char bidi payload of the same
    // length, so only the content changes.
    bytes[bytes.length - 2] = 0xe2;
    bytes[bytes.length - 1] = 0x80;
    const result = decodeHashMarkScript(Uint8Array.from(bytes));
    expect(result.ok).toBe(false);
  });
});

describe("canonical attestation message", () => {
  const base = {
    genesisHash: GENESIS,
    signerHash160: SIGNER,
    algorithmId: 1,
    digest: DIGEST,
  };

  it("is a single line, in fixed key order", () => {
    const message = canonicalAttestationMessage(base);
    expect(message).toBe(
      '{"v":"HashMark/v2","network":"' +
        GENESIS +
        '","signerHash160":"' +
        SIGNER +
        '","algorithmId":"01","digest":"' +
        DIGEST +
        '"}',
    );
    expect(message).not.toContain(String.fromCharCode(10));
  });

  it("omits the label entirely rather than sending an empty one", () => {
    expect(canonicalAttestationMessage(base)).not.toContain("label");
    expect(() =>
      canonicalAttestationMessage({ ...base, label: "" }),
    ).toThrow(AttestationMessageError);
  });

  it("escapes only quotes and backslashes", () => {
    const message = canonicalAttestationMessage({
      ...base,
      label: 'a"b\\c',
    });
    expect(message).toContain('"label":"a\\"b\\\\c"');
  });

  it("changes when any signed field changes", () => {
    const message = canonicalAttestationMessage(base);
    const variants = [
      { ...base, digest: "ab".repeat(32) },
      { ...base, signerHash160: "11".repeat(20) },
      { ...base, genesisHash: "00".repeat(31) + "ff" },
      { ...base, label: "note" },
    ];
    for (const variant of variants) {
      expect(canonicalAttestationMessage(variant)).not.toBe(message);
    }
  });

  it("refuses a statement with no usable network context", () => {
    // A network whose genesis hash is unknown cannot be attested to at all -
    // testnet is deliberately unpopulated until a node has been reached.
    expect(() =>
      canonicalAttestationMessage({ ...base, genesisHash: "" }),
    ).toThrow(AttestationMessageError);
  });

  it("refuses an algorithm it does not know", () => {
    expect(() =>
      canonicalAttestationMessage({ ...base, algorithmId: 9 }),
    ).toThrow(AttestationMessageError);
  });
});
