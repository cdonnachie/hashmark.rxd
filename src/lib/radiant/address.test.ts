/**
 * Address encoding, both directions.
 *
 * A v2 attestation commits to its signer as 20 raw bytes and the interface
 * shows an address, so the two must be exact inverses. A round trip that loses
 * a byte would surface as "signature does not match", sending someone hunting
 * a cryptographic bug that is really a base58 one.
 */
import { describe, expect, it } from "vitest";

import {
  decodeRadiantAddress,
  encodeRadiantAddress,
  hash160,
  isValidRadiantAddress,
  p2pkhScript,
} from "./address";

/** The address that funded the first live HashMark, 345565eb…88892. */
const KNOWN = "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i";

describe("encodeRadiantAddress", () => {
  it("round-trips a known mainnet address", () => {
    const hash = decodeRadiantAddress(KNOWN)!;
    expect(hash).toHaveLength(20);
    expect(encodeRadiantAddress(hash)).toBe(KNOWN);
  });

  it("round-trips addresses whose hash160 has leading zero bytes", () => {
    // Leading zeros become a '1' prefix in base58check and are the classic
    // place a hand-rolled encoder loses a byte.
    const hash = new Uint8Array(20);
    hash[19] = 0x01;
    const address = encodeRadiantAddress(hash);
    expect(address.startsWith("1")).toBe(true);
    expect(decodeRadiantAddress(address)).toEqual(hash);
  });

  it("produces addresses the validator accepts", () => {
    for (let i = 0; i < 8; i++) {
      const hash = new Uint8Array(20).fill(i * 31);
      expect(isValidRadiantAddress(encodeRadiantAddress(hash))).toBe(true);
    }
  });

  it("refuses anything that is not 20 bytes", () => {
    expect(() => encodeRadiantAddress(new Uint8Array(19))).toThrow(/20 bytes/);
    expect(() => encodeRadiantAddress(new Uint8Array(21))).toThrow(/20 bytes/);
  });
});

describe("hash160", () => {
  it("matches the hash embedded in the address's own P2PKH script", () => {
    // Ties the helper to the one place the chain already agrees with us.
    const hash = decodeRadiantAddress(KNOWN)!;
    expect(p2pkhScript(hash).slice(3, 23)).toEqual(hash);
  });

  it("is 20 bytes for any input", () => {
    expect(hash160(new Uint8Array(0))).toHaveLength(20);
    expect(hash160(new Uint8Array(33).fill(2))).toHaveLength(20);
  });
});
