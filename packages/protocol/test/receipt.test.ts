import { describe, expect, it } from "vitest";

import {
  MAX_RECEIPT_BYTES,
  RADIANT_MAINNET,
  buildReceipt,
  parseReceipt,
  serializeReceipt,
  validateReceipt,
} from "../src/index.js";

const TXID = "b".repeat(64);
const DIGEST = "c".repeat(64);

function validReceipt(): Record<string, unknown> {
  return {
    format: "hashmark-receipt",
    version: 1,
    network: "radiant-mainnet",
    algorithm: "sha256",
    digest: DIGEST,
    transactionId: TXID,
    outputIndex: 0,
    genesisHash: RADIANT_MAINNET.genesisHash,
  };
}

describe("buildReceipt / serializeReceipt", () => {
  it("builds a receipt bound to the network's genesis hash", () => {
    const receipt = buildReceipt({
      network: RADIANT_MAINNET,
      algorithm: "sha256",
      digest: DIGEST,
      transactionId: TXID,
      outputIndex: 0,
    });
    expect(receipt.genesisHash).toBe(RADIANT_MAINNET.genesisHash);
    expect(receipt.label).toBeUndefined();
  });

  it("omits an empty label rather than writing a blank one", () => {
    const receipt = buildReceipt({
      network: RADIANT_MAINNET,
      algorithm: "sha256",
      digest: DIGEST,
      transactionId: TXID,
      outputIndex: 0,
      label: "",
    });
    expect(receipt.label).toBeUndefined();
    expect(serializeReceipt(receipt)).not.toContain("label");
  });

  it("round-trips through serialize and parse", () => {
    const receipt = buildReceipt({
      network: RADIANT_MAINNET,
      algorithm: "sha256",
      digest: DIGEST,
      transactionId: TXID,
      outputIndex: 2,
      label: "Contract draft",
    });
    const parsed = parseReceipt(serializeReceipt(receipt));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.receipt).toEqual(receipt);
  });

  it("serializes with stable key order and a trailing newline", () => {
    const text = serializeReceipt(
      buildReceipt({
        network: RADIANT_MAINNET,
        algorithm: "sha256",
        digest: DIGEST,
        transactionId: TXID,
        outputIndex: 0,
      }),
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "format",
      "version",
      "network",
      "algorithm",
      "digest",
      "transactionId",
      "outputIndex",
      "genesisHash",
    ]);
  });
});

describe("validateReceipt", () => {
  it("accepts a well-formed receipt", () => {
    expect(validateReceipt(validReceipt()).ok).toBe(true);
  });

  it("accepts a receipt without the optional genesisHash", () => {
    const receipt = validReceipt();
    delete receipt["genesisHash"];
    expect(validateReceipt(receipt).ok).toBe(true);
  });

  it.each([
    ["a string", "not an object"],
    ["an array", []],
    ["null", null],
    ["a number", 7],
  ])("rejects %s", (_label, input) => {
    const result = validateReceipt(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/must be a JSON object/);
  });

  it("rejects a wrong format tag", () => {
    const result = validateReceipt({ ...validReceipt(), format: "other" });
    expect(result.ok).toBe(false);
  });

  it("distinguishes a newer receipt version from a corrupt one", () => {
    const result = validateReceipt({ ...validReceipt(), version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/newer than this verifier supports/);
    }
  });

  it("rejects an unknown network", () => {
    const result = validateReceipt({ ...validReceipt(), network: "bitcoin" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/unknown network/);
  });

  it("rejects a genesis hash that disagrees with the named network", () => {
    const result = validateReceipt({
      ...validReceipt(),
      genesisHash: "f".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(
        /names one chain and points at another/,
      );
    }
  });

  it("rejects an uppercase digest", () => {
    const result = validateReceipt({ ...validReceipt(), digest: "C".repeat(64) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/lowercase hexadecimal/);
  });

  it("rejects a digest of the wrong length for the algorithm", () => {
    const result = validateReceipt({ ...validReceipt(), digest: "cc" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/64 hex characters/);
  });

  it.each([
    ["too short", "b".repeat(63)],
    ["too long", "b".repeat(65)],
    ["uppercase", "B".repeat(64)],
    ["non-hex", "z".repeat(64)],
    ["empty", ""],
  ])("rejects a %s transaction id", (_label, transactionId) => {
    const result = validateReceipt({ ...validReceipt(), transactionId });
    expect(result.ok).toBe(false);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "0"],
  ])("rejects a %s output index", (_label, outputIndex) => {
    const result = validateReceipt({ ...validReceipt(), outputIndex });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported algorithm", () => {
    const result = validateReceipt({ ...validReceipt(), algorithm: "md5" });
    expect(result.ok).toBe(false);
  });

  it("reports every problem at once, not just the first", () => {
    const result = validateReceipt({
      format: "wrong",
      version: 1,
      network: "nope",
      algorithm: "md5",
      digest: "ZZ",
      transactionId: "short",
      outputIndex: -3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });

  it("ignores unknown extra keys rather than failing", () => {
    const result = validateReceipt({ ...validReceipt(), somethingElse: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const asRecord = result.receipt as unknown as Record<string, unknown>;
      expect(asRecord["somethingElse"]).toBeUndefined();
    }
  });
});

describe("parseReceipt", () => {
  it("rejects malformed JSON", () => {
    const result = parseReceipt("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it("rejects an oversized document before parsing it", () => {
    const result = parseReceipt("x".repeat(MAX_RECEIPT_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/larger than/);
  });

  it("does not choke on a prototype-pollution attempt", () => {
    const hostile = JSON.stringify({
      ...validReceipt(),
      __proto__: { polluted: true },
    });
    expect(() => parseReceipt(hostile)).not.toThrow();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
