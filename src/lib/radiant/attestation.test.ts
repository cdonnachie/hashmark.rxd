/**
 * v2 attestation verification.
 *
 * The test that matters most is the key-substitution one. Every other case
 * here would pass under the broken design this replaced — recover a key from
 * the signature, call it the signer — because that design cannot fail. Only a
 * record whose committed signer disagrees with the recovered key can tell the
 * two apart.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import {
  canonicalAttestationMessage,
  bytesToHex,
  type HashMarkRecord,
} from "@hashmark/protocol";

import { hash160 } from "./address";
import { verifyAttestation } from "./attestation";
import { RADIANT_MESSAGE_PREFIX, signBitcoinStyleMessage } from "./signmessage";

/** Radiant mainnet. A statement is bound to the chain it was made on. */
const GENESIS =
  "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4";
const OTHER_GENESIS = "00".repeat(31) + "ff";

const KEY_A = new Uint8Array(32).fill(0x11);
const KEY_B = new Uint8Array(32).fill(0x22);

const DIGEST = "e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e";

function signerHashFor(key: Uint8Array): string {
  return bytesToHex(hash160(secp256k1.getPublicKey(key, true)));
}

function base64ToHex(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytesToHex(bytes);
}

/** A record signed properly by `key`, over its own committed signer. */
function signedRecord(
  key: Uint8Array,
  extra: { label?: string; genesisHash?: string } = {},
): HashMarkRecord {
  const signerHash160 = signerHashFor(key);
  const message = canonicalAttestationMessage({
    genesisHash: extra.genesisHash ?? GENESIS,
    signerHash160,
    algorithmId: 1,
    digest: DIGEST,
    label: extra.label,
  });
  const signature = base64ToHex(
    signBitcoinStyleMessage({
      privateKey: key,
      message,
      messagePrefix: RADIANT_MESSAGE_PREFIX,
    }),
  );
  return {
    version: 2,
    algorithmId: 1,
    algorithm: "sha256",
    digest: DIGEST,
    signerHash160,
    signature,
    ...(extra.label === undefined ? {} : { label: extra.label }),
  };
}

describe("verifyAttestation", () => {
  it("accepts a record whose signature recovers to its committed signer", () => {
    const result = verifyAttestation(signedRecord(KEY_A), GENESIS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signer).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
      expect(result.message).toContain('"v":"HashMark/v2"');
      expect(result.message).toContain(DIGEST);
    }
  });

  it("accepts a labelled record, with the label inside the statement", () => {
    const result = verifyAttestation(
      signedRecord(KEY_A, { label: "Contract draft" }),
      GENESIS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain('"label":"Contract draft"');
  });

  it("refuses a key-substitution attempt", () => {
    // The attack the committed signer exists to stop, mounted the only way it
    // can be: sign under one committed hash, then overwrite that hash with the
    // one the signature recovers to. The overwrite changes the message, so the
    // signature no longer recovers to anything matching it.
    const decoy = "11".repeat(20);
    const message = canonicalAttestationMessage({
      genesisHash: GENESIS,
      signerHash160: decoy,
      algorithmId: 1,
      digest: DIGEST,
    });
    const signature = base64ToHex(
      signBitcoinStyleMessage({
        privateKey: KEY_B,
        message,
        messagePrefix: RADIANT_MESSAGE_PREFIX,
      }),
    );

    const forged: HashMarkRecord = {
      version: 2,
      algorithmId: 1,
      algorithm: "sha256",
      digest: DIGEST,
      // The hash the signature really recovers to, substituted in afterwards.
      signerHash160: signerHashFor(KEY_B),
      signature,
    };

    const result = verifyAttestation(forged, GENESIS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SIGNER_MISMATCH");
  });

  it.each([
    ["signerHash160", (r: HashMarkRecord) => ({ ...r, signerHash160: "22".repeat(20) })],
    ["digest", (r: HashMarkRecord) => ({ ...r, digest: "ab".repeat(32) })],
    ["algorithmId", (r: HashMarkRecord) => ({ ...r, algorithmId: 2 })],
    ["label", (r: HashMarkRecord) => ({ ...r, label: "changed" })],
  ])("refuses a record with %s mutated after signing", (_field, mutate) => {
    const result = verifyAttestation(mutate(signedRecord(KEY_A)), GENESIS);
    expect(result.ok).toBe(false);
  });

  it("refuses the same record verified against a different chain", () => {
    const record = signedRecord(KEY_A);
    expect(verifyAttestation(record, GENESIS).ok).toBe(true);
    expect(verifyAttestation(record, OTHER_GENESIS).ok).toBe(false);
  });

  it("refuses a high-S signature", () => {
    const record = signedRecord(KEY_A);
    const bytes = Uint8Array.from(
      record.signature!.match(/../g)!.map((h) => parseInt(h, 16)),
    );
    // s := n - s. Still a mathematically valid signature, deliberately not a
    // canonical one, so it must be refused rather than quietly accepted.
    const n = secp256k1.Point.Fn.ORDER;
    let s = 0n;
    for (const byte of bytes.subarray(33, 65)) s = (s << 8n) | BigInt(byte);
    const flipped = n - s;
    for (let i = 0; i < 32; i++) {
      bytes[64 - i] = Number((flipped >> BigInt(8 * i)) & 0xffn);
    }
    const result = verifyAttestation(
      { ...record, signature: bytesToHex(bytes) },
      GENESIS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_SIGNATURE");
  });

  it("refuses a signature header outside 27..34", () => {
    const record = signedRecord(KEY_A);
    const bytes = Uint8Array.from(
      record.signature!.match(/../g)!.map((h) => parseInt(h, 16)),
    );
    bytes[0] = 26;
    const result = verifyAttestation(
      { ...record, signature: bytesToHex(bytes) },
      GENESIS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED_SIGNATURE");
  });

  it("reports a v1 record as unsigned, not as invalid", () => {
    const v1: HashMarkRecord = {
      version: 1,
      algorithmId: 1,
      algorithm: "sha256",
      digest: DIGEST,
    };
    const result = verifyAttestation(v1, GENESIS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNSIGNED");
  });

  it("accepts a different signer's valid attestation of the same file", () => {
    // Replacing BOTH signature and committed signer is not forgery — it is
    // somebody else making their own statement, which anyone may do. Telling
    // that apart from "the signer you expected" is the receipt's job.
    const mine = verifyAttestation(signedRecord(KEY_A), GENESIS);
    const theirs = verifyAttestation(signedRecord(KEY_B), GENESIS);
    expect(mine.ok).toBe(true);
    expect(theirs.ok).toBe(true);
    if (mine.ok && theirs.ok) expect(mine.signer).not.toBe(theirs.signer);
  });
});
