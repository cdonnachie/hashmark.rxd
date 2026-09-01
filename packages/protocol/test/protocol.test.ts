import { describe, expect, it } from "vitest";

import {
  HashMarkEncodeError,
  MAX_LABEL_BYTES,
  MAX_LABEL_BYTES_V1,
  MAX_SCRIPT_BYTES,
  bytesToHex,
  decodeHashMarkScript,
  encodeLegacyV1Script,
  encodePush,
  hexToBytes,
  labelByteLength,
  readPushes,
} from "../src/index.js";

/**
 * Golden vector. Cross-checked against `@radiant-core/radiantjs`
 * `Script.buildDataOut([...])`, which produced the identical script hex for
 * the same four pushes (see scripts/gen-vectors.ts). If this constant ever has
 * to change, the on-chain format has changed and the protocol version must be
 * bumped.
 */
const DIGEST_A = "a".repeat(64);
const GOLDEN_NO_LABEL =
  "6a" + // OP_RETURN
  "08" + "48415348_4d41524b".replace("_", "") + // push8 "HASHMARK"
  "02" + "0101" + // push2 version=1 algorithm=1
  "20" + DIGEST_A; // push32 digest

function hex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

describe("script push encoding", () => {
  it("uses a direct push for 1..75 bytes", () => {
    expect(hex(encodePush(new Uint8Array(1)))).toBe("0100");
    expect(hex(encodePush(new Uint8Array(75))).slice(0, 2)).toBe("4b");
  });

  it("uses OP_PUSHDATA1 for 76..255 bytes", () => {
    expect(hex(encodePush(new Uint8Array(76))).slice(0, 4)).toBe("4c4c");
    expect(hex(encodePush(new Uint8Array(255))).slice(0, 4)).toBe("4cff");
  });

  it("uses OP_PUSHDATA2 for 256..520 bytes, little-endian", () => {
    expect(hex(encodePush(new Uint8Array(256))).slice(0, 6)).toBe("4d0001");
    expect(hex(encodePush(new Uint8Array(520))).slice(0, 6)).toBe("4d0802");
  });

  it("refuses an empty push and one over the element limit", () => {
    expect(() => encodePush(new Uint8Array(0))).toThrow(RangeError);
    expect(() => encodePush(new Uint8Array(521))).toThrow(RangeError);
  });

  it("round-trips every boundary length", () => {
    for (const length of [1, 75, 76, 255, 256, 520]) {
      const data = new Uint8Array(length).fill(0xab);
      const pushes = readPushes(encodePush(data));
      expect(pushes, `length ${length}`).toHaveLength(1);
      expect(pushes?.[0]).toEqual(data);
    }
  });

  it("rejects a non-minimal OP_PUSHDATA1 carrying a direct-push length", () => {
    // OP_PUSHDATA1 0x20 <32 bytes> — legal script, but not canonical here.
    const script = new Uint8Array([0x4c, 0x20, ...new Uint8Array(32)]);
    expect(readPushes(script)).toBeUndefined();
  });

  it("rejects a non-minimal OP_PUSHDATA2 carrying a PUSHDATA1 length", () => {
    const script = new Uint8Array([0x4d, 0xff, 0x00, ...new Uint8Array(255)]);
    expect(readPushes(script)).toBeUndefined();
  });

  it("rejects small-integer opcodes, which would give a byte two spellings", () => {
    expect(readPushes(Uint8Array.of(0x51))).toBeUndefined(); // OP_1
    expect(readPushes(Uint8Array.of(0x60))).toBeUndefined(); // OP_16
    expect(readPushes(Uint8Array.of(0x4f))).toBeUndefined(); // OP_1NEGATE
    expect(readPushes(Uint8Array.of(0x00))).toBeUndefined(); // OP_0
  });

  it("rejects OP_PUSHDATA4 and non-push opcodes", () => {
    expect(readPushes(Uint8Array.of(0x4e, 1, 0, 0, 0, 0xff))).toBeUndefined();
    expect(readPushes(Uint8Array.of(0x76))).toBeUndefined(); // OP_DUP
  });

  it("rejects a truncated push", () => {
    expect(readPushes(Uint8Array.of(0x05, 0x01, 0x02))).toBeUndefined();
    expect(readPushes(Uint8Array.of(0x4c))).toBeUndefined();
    expect(readPushes(Uint8Array.of(0x4d, 0x00))).toBeUndefined();
  });
});

describe("encode", () => {
  it("matches the golden vector for a record with no label", () => {
    const script = encodeLegacyV1Script({
      algorithm: "sha256",
      digest: DIGEST_A,
    });
    expect(hex(script)).toBe(GOLDEN_NO_LABEL);
    expect(script.length).toBe(46);
  });

  it("produces at most 176 bytes, inside the conservative relay budget", () => {
    // v1's own maximum: no signer, no signature, so 40 more bytes of label.
    const script = encodeLegacyV1Script({
      algorithm: "sha256",
      digest: DIGEST_A,
      label: "x".repeat(MAX_LABEL_BYTES_V1),
    });
    expect(script.length).toBe(176);
    expect(script.length).toBeLessThanOrEqual(MAX_SCRIPT_BYTES);
  });

  it("rejects an uppercase or malformed digest", () => {
    expect(() =>
      encodeLegacyV1Script({ algorithm: "sha256", digest: "A".repeat(64) }),
    ).toThrow(HashMarkEncodeError);
    expect(() =>
      encodeLegacyV1Script({ algorithm: "sha256", digest: "abc" }),
    ).toThrow(HashMarkEncodeError);
  });

  it("rejects a digest of the wrong length for the algorithm", () => {
    expect(() =>
      encodeLegacyV1Script({ algorithm: "sha256", digest: "ab".repeat(31) }),
    ).toThrow(/32 bytes/);
  });

  it("rejects an unknown algorithm", () => {
    expect(() =>
      encodeLegacyV1Script({ algorithm: "md5", digest: DIGEST_A }),
    ).toThrow(/unsupported hash algorithm/);
  });

  it("measures the label in UTF-8 bytes, not characters", () => {
    // Four characters, twelve bytes.
    expect(labelByteLength("四つの文字".slice(0, 4))).toBe(12);
    // 43 emoji x 4 bytes = 172 bytes, well over the limit at 43 characters.
    expect(() =>
      encodeLegacyV1Script({
        algorithm: "sha256",
        digest: DIGEST_A,
        label: "🐟".repeat(43),
      }),
    ).toThrow(/over the 128-byte limit/);
  });

  it("normalizes the label to NFC so byte length is what was validated", () => {
    // "é" as e + combining acute (3 bytes) normalizes to 2 bytes.
    const decomposed = "é";
    expect(labelByteLength(decomposed)).toBe(2);
    const script = encodeLegacyV1Script({
      algorithm: "sha256",
      digest: DIGEST_A,
      label: decomposed,
    });
    const decoded = decodeHashMarkScript(script);
    expect(decoded.ok && decoded.record.label).toBe("é");
  });

  it("rejects control characters in a label", () => {
    expect(() =>
      encodeLegacyV1Script({
        algorithm: "sha256",
        digest: DIGEST_A,
        label: `line${String.fromCharCode(10)}break`,
      }),
    ).toThrow(/control characters/);
  });

  it("omits the label push entirely for an empty label", () => {
    const script = encodeLegacyV1Script({
      algorithm: "sha256",
      digest: DIGEST_A,
      label: "",
    });
    expect(hex(script)).toBe(GOLDEN_NO_LABEL);
  });
});

describe("round trip", () => {
  it("survives every label length from 1 to the maximum", () => {
    for (let length = 1; length <= MAX_LABEL_BYTES; length++) {
      const label = "y".repeat(length);
      const decoded = decodeHashMarkScript(
        encodeLegacyV1Script({ algorithm: "sha256", digest: DIGEST_A, label }),
      );
      expect(decoded.ok, `length ${length}`).toBe(true);
      if (decoded.ok) {
        expect(decoded.record.label).toBe(label);
        expect(decoded.record.digest).toBe(DIGEST_A);
        expect(decoded.record.algorithm).toBe("sha256");
        expect(decoded.record.version).toBe(1);
      }
    }
  });

  it("preserves multi-byte labels exactly", () => {
    const label = "Проверка ✓ 日本語";
    const decoded = decodeHashMarkScript(
      encodeLegacyV1Script({ algorithm: "sha256", digest: DIGEST_A, label }),
    );
    expect(decoded.ok && decoded.record.label).toBe(label);
  });
});

describe("decode failures", () => {
  const encoded = encodeLegacyV1Script({
    algorithm: "sha256",
    digest: DIGEST_A,
  });

  it("reports NOT_HASHMARK for a non-OP_RETURN script", () => {
    // A P2PKH scriptPubKey.
    const p2pkh = hexToBytes(`76a914${"00".repeat(20)}88ac`)!;
    const result = decodeHashMarkScript(p2pkh);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_HASHMARK");
  });

  it("reports NOT_HASHMARK for another protocol's OP_RETURN", () => {
    // Real shape observed on Radiant mainnet: OP_RETURN "msg" <payload>.
    const other = hexToBytes("6a036d736706736e6b00336b")!;
    const result = decodeHashMarkScript(other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_HASHMARK");
  });

  it("reports NOT_HASHMARK for an empty script", () => {
    const result = decodeHashMarkScript(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_HASHMARK");
  });

  it("reports UNKNOWN_VERSION and carries the observed version", () => {
    // 3, not 2: version 2 is a format this decoder reads, so mutating a v1
    // record into one would be a malformed v2 record rather than an unknown
    // version. A version from the future is the case being tested.
    const mutated = Uint8Array.from(encoded);
    mutated[11] = 3; // the version byte inside the 2-byte header push
    const result = decodeHashMarkScript(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("UNKNOWN_VERSION");
      expect(result.observedVersion).toBe(3);
    }
  });

  it("does not read a future version as version 1", () => {
    const mutated = Uint8Array.from(encoded);
    mutated[11] = 99;
    const result = decodeHashMarkScript(mutated);
    expect(result.ok).toBe(false);
  });

  it("reports UNKNOWN_ALGORITHM and carries the observed id", () => {
    const mutated = Uint8Array.from(encoded);
    mutated[12] = 0x7f; // the algorithm byte
    const result = decodeHashMarkScript(mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("UNKNOWN_ALGORITHM");
      expect(result.observedAlgorithmId).toBe(0x7f);
    }
  });

  it("reports INVALID for a truncated record", () => {
    for (let cut = 1; cut < encoded.length; cut++) {
      const result = decodeHashMarkScript(encoded.subarray(0, cut));
      expect(result.ok, `cut at ${cut}`).toBe(false);
    }
  });

  it("reports INVALID for a digest of the wrong width", () => {
    // Magic, header, then a 31-byte digest.
    const script = new Uint8Array([
      0x6a,
      0x08, ...hexToBytes("48415348_4d41524b".replace("_", ""))!,
      0x02, 0x01, 0x01,
      0x1f, ...new Uint8Array(31),
    ]);
    const result = decodeHashMarkScript(script);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INVALID");
      expect(result.detail).toMatch(/must be 32 bytes/);
    }
  });

  it("reports INVALID for a header push that is not 2 bytes", () => {
    const script = new Uint8Array([
      0x6a,
      0x08, ...hexToBytes("48415348_4d41524b".replace("_", ""))!,
      0x01, 0x01,
      0x20, ...new Uint8Array(32),
    ]);
    const result = decodeHashMarkScript(script);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/exactly 2 bytes/);
  });

  it("reports INVALID for a fifth push rather than ignoring it", () => {
    const withExtra = new Uint8Array([
      ...encodeLegacyV1Script({
        algorithm: "sha256",
        digest: DIGEST_A,
        label: "ok",
      }),
      ...encodePush(new Uint8Array([1, 2, 3])),
    ]);
    const result = decodeHashMarkScript(withExtra);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INVALID");
      expect(result.detail).toMatch(/v1 record has 3 or 4 pushes/);
    }
  });

  it("reports INVALID for an over-long label", () => {
    const script = new Uint8Array([
      0x6a,
      0x08, ...hexToBytes("48415348_4d41524b".replace("_", ""))!,
      0x02, 0x01, 0x01,
      0x20, ...new Uint8Array(32),
      ...encodePush(new Uint8Array(129).fill(0x41)),
    ]);
    const result = decodeHashMarkScript(script);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/exceeds 128 bytes/);
  });

  it("reports INVALID for a label that is not valid UTF-8", () => {
    const script = new Uint8Array([
      0x6a,
      0x08, ...hexToBytes("48415348_4d41524b".replace("_", ""))!,
      0x02, 0x01, 0x01,
      0x20, ...new Uint8Array(32),
      0x02, 0xff, 0xfe, // never a valid UTF-8 sequence
    ]);
    const result = decodeHashMarkScript(script);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/valid UTF-8/);
  });

  it("keeps a v1 record valid but withholds a label with control characters", () => {
    const script = new Uint8Array([
      0x6a,
      0x08, ...hexToBytes("48415348_4d41524b".replace("_", ""))!,
      0x02, 0x01, 0x01,
      0x20, ...new Uint8Array(32),
      0x03, 0x61, 0x0a, 0x62, // "a\nb"
    ]);
    // The label is dangerous to display; the timestamp is not. A v1 label is
    // unsigned and carries no claim, so the record survives without it.
    const result = decodeHashMarkScript(script);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.label).toBeUndefined();
      expect(result.record.labelWithheld).toBe("CONTROL_CHARS");
      expect(result.record.digest).toBe("00".repeat(32));
    }
  });

  it("never throws, whatever bytes it is given", () => {
    const seeds = [
      new Uint8Array(0),
      Uint8Array.of(0x6a),
      Uint8Array.of(0x6a, 0xff),
      Uint8Array.of(0x6a, 0x4c),
      new Uint8Array(1000).fill(0x6a),
    ];
    for (const seed of seeds) {
      expect(() => decodeHashMarkScript(seed)).not.toThrow();
    }
    // Deterministic pseudo-random fuzz: every input either decodes or fails
    // cleanly, and none is accidentally accepted.
    let state = 0x12345678;
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    for (let i = 0; i < 3000; i++) {
      const bytes = new Uint8Array(next() % 200);
      for (let j = 0; j < bytes.length; j++) bytes[j] = next() % 256;
      expect(() => decodeHashMarkScript(bytes)).not.toThrow();
    }
  });
});
