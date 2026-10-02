/**
 * Inclusion proofs, against a real mainnet proof pinned as a fixture.
 *
 * The fixture is the first signed HashMark (a1a86ab4…045916, block 460572),
 * with both Merkle branches and the header exactly as ElectrumX returned
 * them, and the checkpoint scripts/gen-checkpoint.ts produced after two
 * independent operators agreed on it. Every test is offline.
 *
 * The negative cases matter more than the positive one. A proof checker that
 * says "proved" is easy to write; one that says "contradicted" for every way a
 * server could get it wrong is the actual deliverable.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { hexToBytes } from "@hashmark/protocol";

import fixture from "./__fixtures__/inclusion-proof.json";
import { HEADER_CHECKPOINT } from "./checkpoint";
import { parseHeader } from "./header";
import { checkInclusion } from "./inclusion";
import { merkleRootFromBranch, reverseBytes } from "./merkle";

const base = {
  txid: fixture.txid,
  height: fixture.height,
  position: fixture.position,
  txBranch: fixture.txBranch,
  headerHex: fixture.headerHex,
  headerBranch: fixture.headerBranch,
  checkpoint: fixture.checkpoint,
};

/** Flip one hex nibble at `index` of a hex string. */
function flip(hex: string, index: number): string {
  const c = hex[index]!;
  const swapped = c === "0" ? "1" : "0";
  return hex.slice(0, index) + swapped + hex.slice(index + 1);
}

describe("checkInclusion against a real mainnet proof", () => {
  it("proves the first signed HashMark is in block 460572", () => {
    const result = checkInclusion(base);
    expect(result.kind).toBe("proved");
    if (result.kind !== "proved") return;
    expect(result.height).toBe(460572);
    // The timestamp is now read from a proved header, not reported.
    expect(result.blockTime).toBe(fixture.expectedHeaderTime);
    expect(result.blockTime).toBe(1788272741);
  });

  it("ships the checkpoint the fixture was proved against", () => {
    // If someone regenerates one without the other, every real proof breaks
    // in production while this file still passes. Keep them in step.
    expect(HEADER_CHECKPOINT).toEqual(fixture.checkpoint);
  });

  it("is contradicted by a tampered transaction branch", () => {
    const txBranch = [...base.txBranch];
    txBranch[1] = flip(txBranch[1]!, 10);
    expect(checkInclusion({ ...base, txBranch }).kind).toBe("contradicted");
  });

  it("is contradicted by a tampered header branch", () => {
    const headerBranch = [...base.headerBranch];
    headerBranch[7] = flip(headerBranch[7]!, 30);
    expect(checkInclusion({ ...base, headerBranch }).kind).toBe("contradicted");
  });

  it("is contradicted when the header's timestamp is altered", () => {
    // The attack the whole feature exists for: move the mark in time. The
    // time is inside the header, the header's hash is a leaf of the
    // checkpoint tree, so the edit breaks the header branch.
    const timeOffset = 68 * 2; // byte 68 of the header, as hex
    const headerHex = flip(base.headerHex, timeOffset);
    const result = checkInclusion({ ...base, headerHex });
    expect(result.kind).toBe("contradicted");
  });

  it("is contradicted when asked about a different height", () => {
    // A server lying about which block holds the transaction cannot make the
    // header branch land on the checkpoint at the wrong position.
    expect(checkInclusion({ ...base, height: base.height + 1 }).kind).toBe(
      "contradicted",
    );
  });

  it("is contradicted for a different transaction in the same block", () => {
    const txid = flip(base.txid, 0);
    expect(checkInclusion({ ...base, txid }).kind).toBe("contradicted");
  });

  it("is contradicted against a different anchor", () => {
    const checkpoint = { ...base.checkpoint, root: flip(base.checkpoint.root, 5) };
    expect(checkInclusion({ ...base, checkpoint }).kind).toBe("contradicted");
  });

  it("is contradicted by a header that is not 80 bytes", () => {
    expect(
      checkInclusion({ ...base, headerHex: base.headerHex.slice(0, 158) }).kind,
    ).toBe("contradicted");
  });
});

describe("Radiant header hashing", () => {
  it("uses double SHA-512/256, and double SHA-256 would not prove", () => {
    // Pins the one Radiant divergence that broke the first attempt at this:
    // the header tree's leaves are double SHA-512/256 while its pairing is
    // double SHA-256. A branch walked from the wrong leaf is internally
    // consistent and lands on the wrong root — silently, if nothing checks.
    const bytes = hexToBytes(base.headerHex)!;
    const wrongLeaf = sha256(sha256(bytes));
    const wrongRoot = merkleRootFromBranch(
      wrongLeaf,
      base.headerBranch.map((h) => reverseBytes(hexToBytes(h)!)),
      base.height,
    );
    const right = parseHeader(bytes)!;
    const rightRoot = merkleRootFromBranch(
      right.hash,
      base.headerBranch.map((h) => reverseBytes(hexToBytes(h)!)),
      base.height,
    );
    const toDisplay = (b: Uint8Array) =>
      Array.from(reverseBytes(b), (x) => x.toString(16).padStart(2, "0")).join("");

    expect(toDisplay(rightRoot)).toBe(base.checkpoint.root);
    expect(toDisplay(wrongRoot)).not.toBe(base.checkpoint.root);
  });
});

describe("merkleRootFromBranch", () => {
  it("rejects a branch too short for its index", () => {
    expect(() =>
      merkleRootFromBranch(new Uint8Array(32), [new Uint8Array(32)], 4),
    ).toThrow(/too short/);
  });

  it("rejects elements that are not 32 bytes", () => {
    expect(() =>
      merkleRootFromBranch(new Uint8Array(32), [new Uint8Array(31)], 0),
    ).toThrow(/32 bytes/);
  });

  it("returns the leaf itself for an empty branch at index 0", () => {
    const leaf = new Uint8Array(32).fill(7);
    expect(merkleRootFromBranch(leaf, [], 0)).toEqual(leaf);
  });
});
