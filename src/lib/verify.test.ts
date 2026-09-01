/**
 * What the chain says, not what the index says.
 *
 * `searchDigest` takes hints from an index it does not trust. These tests hold
 * it to the promise in HASHMARK_PROTOCOL.md §2.8: a hostile or buggy index can
 * cost a user a result, but it can never manufacture one. Every hit is fetched
 * and decoded again here, and anything that does not survive that is counted as
 * rejected rather than shown.
 */
import { bytesToHex, encodeLegacyV1Script } from "@hashmark/protocol";
import { describe, expect, it } from "vitest";

import type { RadiantChain, TransactionDetails } from "@/lib/radiant/chain";

import { searchDigest, type IndexHit } from "./verify";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "c".repeat(64);
const MARKED_TX = "1".repeat(64);
const IMPOSTOR_TX = "2".repeat(64);
const MISSING_TX = "3".repeat(64);

function markScript(digest: string): string {
  return bytesToHex(encodeLegacyV1Script({ algorithm: "sha256", digest }));
}

function transaction(txid: string, digest: string): TransactionDetails {
  return {
    txid,
    outputs: [
      { index: 0, scriptHex: markScript(digest), value: 0 },
      { index: 1, scriptHex: "76a914" + "00".repeat(20) + "88ac", value: 1000 },
    ],
    blockHash: "f".repeat(64),
    blockTime: 1_780_000_000,
    confirmations: 12,
    state: "confirmed",
    rawHex: "",
  };
}

/** A chain that answers only for the transactions it was given. */
function fakeChain(transactions: Record<string, TransactionDetails>) {
  return {
    async getTransaction(txid: string) {
      const found = transactions[txid];
      if (!found) throw new Error("no such transaction");
      return found;
    },
  } as unknown as RadiantChain;
}

const hint = (txid: string): IndexHit => ({ txid, outputIndex: 0, height: 1 });

describe("searchDigest", () => {
  it("returns marks the chain confirms carry the digest", async () => {
    const chain = fakeChain({ [MARKED_TX]: transaction(MARKED_TX, DIGEST) });

    const { marks, rejected } = await searchDigest(chain, DIGEST, async () => [
      hint(MARKED_TX),
    ]);

    expect(rejected).toBe(0);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.txid).toBe(MARKED_TX);
    expect(marks[0]!.record.digest).toBe(DIGEST);
  });

  it("discards a hit whose on-chain record is for a different file", async () => {
    // The index claims this transaction marks our digest. It does not.
    const chain = fakeChain({
      [IMPOSTOR_TX]: transaction(IMPOSTOR_TX, OTHER_DIGEST),
    });

    const { marks, rejected } = await searchDigest(chain, DIGEST, async () => [
      hint(IMPOSTOR_TX),
    ]);

    expect(marks).toEqual([]);
    expect(rejected).toBe(1);
  });

  it("discards a hit pointing at a transaction that cannot be fetched", async () => {
    const chain = fakeChain({});

    const { marks, rejected } = await searchDigest(chain, DIGEST, async () => [
      hint(MISSING_TX),
    ]);

    expect(marks).toEqual([]);
    expect(rejected).toBe(1);
  });

  it("checks the output the index named, not merely the transaction", async () => {
    const chain = fakeChain({ [MARKED_TX]: transaction(MARKED_TX, DIGEST) });

    // Output 1 is the change output; the mark is at 0.
    const { marks, rejected } = await searchDigest(chain, DIGEST, async () => [
      { txid: MARKED_TX, outputIndex: 1, height: 1 },
    ]);

    expect(marks).toEqual([]);
    expect(rejected).toBe(1);
  });

  it("never touches the chain when the index returns nothing", async () => {
    const chain = fakeChain({});
    await expect(searchDigest(chain, DIGEST, async () => [])).resolves.toEqual({
      marks: [],
      rejected: 0,
    });
  });

  it("lets a lookup failure through instead of reporting an empty search", async () => {
    const chain = fakeChain({});
    await expect(
      searchDigest(chain, DIGEST, async () => {
        throw new Error("index unreachable");
      }),
    ).rejects.toThrow("index unreachable");
  });
});
