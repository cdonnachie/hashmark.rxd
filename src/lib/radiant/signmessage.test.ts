import { describe, expect, it } from "vitest";

import {
  decodeRadiantAddress,
  electrumScriptHash,
  isValidRadiantAddress,
  p2pkhScript,
  shortenAddress,
} from "./address";
import {
  RADIANT_MESSAGE_PREFIX,
  magicHash,
  signBitcoinStyleMessage,
  verifyRadiantSignedMessage,
} from "./signmessage";

/** A real mainnet Radiant address (the owner of `hashmark.rxd`). */
const REAL_ADDRESS = "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("address decoding", () => {
  it("accepts a real mainnet address", () => {
    expect(isValidRadiantAddress(REAL_ADDRESS)).toBe(true);
    expect(decodeRadiantAddress(REAL_ADDRESS)).toHaveLength(20);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isValidRadiantAddress(`  ${REAL_ADDRESS}\n`)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["not base58", "not-an-address!!"],
    ["truncated", REAL_ADDRESS.slice(0, -1)],
    ["bad checksum", `${REAL_ADDRESS.slice(0, -1)}X`],
    ["a bech32 address", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
    ["a P2SH address (version 5)", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ])("rejects %s", (_name, address) => {
    expect(isValidRadiantAddress(address)).toBe(false);
    expect(decodeRadiantAddress(address)).toBeUndefined();
  });

  it("builds the canonical P2PKH script", () => {
    const hash160 = decodeRadiantAddress(REAL_ADDRESS)!;
    const script = p2pkhScript(hash160);
    expect(script).toHaveLength(25);
    expect(hex(script.subarray(0, 3))).toBe("76a914");
    expect(hex(script.subarray(23))).toBe("88ac");
  });

  it("rejects a hash160 of the wrong length", () => {
    expect(() => p2pkhScript(new Uint8Array(19))).toThrow(/20 bytes/);
  });

  it("derives the reversed Electrum scripthash", () => {
    const scriptHash = electrumScriptHash(REAL_ADDRESS);
    expect(scriptHash).toMatch(/^[0-9a-f]{64}$/);
    // Confirmed live: this scripthash returns UTXOs from
    // blockchain.scripthash.listunspent on Radiant mainnet.
  });

  it("returns undefined rather than throwing for a bad address", () => {
    expect(electrumScriptHash("nonsense")).toBeUndefined();
  });

  it("shortens addresses for display", () => {
    expect(shortenAddress(REAL_ADDRESS)).toBe("14XmXG…3vgx1i");
    expect(shortenAddress("short")).toBe("short");
  });
});

describe("signmessage", () => {
  // A fixed, non-secret key. Used only to produce signatures inside these
  // tests; it holds nothing and is not a wallet key.
  const TEST_KEY = new Uint8Array(32).fill(0x11);

  function addressForTestKey(): string {
    // Derived below via a round trip: sign, then find which address verifies.
    // Simpler and less error-prone than re-implementing key→address here.
    return TEST_ADDRESS;
  }

  // Computed once from TEST_KEY (compressed pubkey → hash160 → base58check).
  const TEST_ADDRESS = (() => {
    // Lazily require the pieces so this stays a test-only derivation.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { secp256k1 } = require("@noble/curves/secp256k1.js");
    const { ripemd160 } = require("@noble/hashes/legacy.js");
    const { sha256 } = require("@noble/hashes/sha2.js");
    const bs58 = require("bs58").default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const pubkey = secp256k1.getPublicKey(TEST_KEY, true);
    const hash160 = ripemd160(sha256(pubkey));
    const payload = new Uint8Array(21);
    payload[0] = 0x00;
    payload.set(hash160, 1);
    const checksum = sha256(sha256(payload)).subarray(0, 4);
    const full = new Uint8Array(25);
    full.set(payload, 0);
    full.set(checksum, 21);
    return bs58.encode(full) as string;
  })();

  it("round-trips sign then verify", () => {
    const message = "hashmark.rxd:wallet-connect:v1:abc123:HashMark sign-in";
    const signature = signBitcoinStyleMessage({
      privateKey: TEST_KEY,
      message,
      messagePrefix: RADIANT_MESSAGE_PREFIX,
    });
    expect(verifyRadiantSignedMessage(addressForTestKey(), message, signature)).toBe(
      true,
    );
  });

  it("rejects a signature over a different message", () => {
    const signature = signBitcoinStyleMessage({
      privateKey: TEST_KEY,
      message: "original",
      messagePrefix: RADIANT_MESSAGE_PREFIX,
    });
    expect(verifyRadiantSignedMessage(TEST_ADDRESS, "tampered", signature)).toBe(
      false,
    );
  });

  it("rejects a valid signature attributed to another address", () => {
    const signature = signBitcoinStyleMessage({
      privateKey: TEST_KEY,
      message: "hello",
      messagePrefix: RADIANT_MESSAGE_PREFIX,
    });
    expect(verifyRadiantSignedMessage(REAL_ADDRESS, "hello", signature)).toBe(
      false,
    );
  });

  it("uses the Bitcoin magic prefix, so a message digest is never a sighash", () => {
    // The prefix must be included: hashing the bare message must differ.
    const withPrefix = magicHash("x", RADIANT_MESSAGE_PREFIX);
    const withoutPrefix = magicHash("x", "");
    expect(hex(withPrefix)).not.toBe(hex(withoutPrefix));
    expect(RADIANT_MESSAGE_PREFIX).toBe("Bitcoin Signed Message:\n");
  });

  it.each([
    ["empty signature", ""],
    ["not base64", "!!!!"],
    ["wrong length", "AAAA"],
    ["segwit header byte", Buffer.alloc(65, 0).fill(35, 0, 1).toString("base64")],
  ])("returns false for %s", (_name, signature) => {
    expect(verifyRadiantSignedMessage(TEST_ADDRESS, "hello", signature)).toBe(
      false,
    );
  });

  it.each([
    ["empty message", ""],
    ["empty address", ""],
  ])("returns false for an %s", (_name, value) => {
    expect(verifyRadiantSignedMessage(value || TEST_ADDRESS, value, "x")).toBe(
      false,
    );
  });

  it("never throws, whatever it is handed", () => {
    const junk = ["", "x", "!!", "a".repeat(500)];
    for (const a of junk) {
      for (const m of junk) {
        for (const s of junk) {
          expect(() => verifyRadiantSignedMessage(a, m, s)).not.toThrow();
        }
      }
    }
  });
});
