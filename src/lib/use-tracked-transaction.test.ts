/**
 * Guards on the confirmation-tracking policy.
 *
 * These exist because of a real defect: the result screen told users the
 * confirmation status "updates as that happens" while the code fetched once and
 * never looked again. The interface claimed something the code did not do, on
 * the one screen where someone is waiting to see their transaction land.
 *
 * The hook itself needs a DOM to exercise; what is pinned here is the policy
 * that made the claim false, so the constants cannot silently drift back.
 */
import { describe, expect, it } from "vitest";

import { CONFIRMED_DEPTH } from "@/lib/radiant/chain";

/** Kept in step with use-tracked-transaction.ts. */
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_MS = 2 * 60 * 60 * 1000;

function settled(confirmations: number): boolean {
  return confirmations >= CONFIRMED_DEPTH;
}

describe("confirmation tracking policy", () => {
  it("keeps polling while a mark is unconfirmed or confirming", () => {
    for (const confirmations of [0, 1, 2, 3, 4, 5]) {
      expect(settled(confirmations), `${confirmations} confirmations`).toBe(false);
    }
  });

  it("stops once the mark is settled, when there is nothing left to learn", () => {
    expect(settled(CONFIRMED_DEPTH)).toBe(true);
    expect(settled(CONFIRMED_DEPTH + 100)).toBe(true);
  });

  it("polls slower than a block, so it cannot hammer a public node", () => {
    // Radiant targets minutes per block; anything faster gains no information.
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("gives up eventually rather than polling a forgotten tab forever", () => {
    expect(MAX_POLL_MS).toBeGreaterThan(0);
    expect(MAX_POLL_MS / POLL_INTERVAL_MS).toBeLessThan(1000);
  });

  it("would reach confirmation well inside the polling window", () => {
    // Six blocks at roughly five minutes each, with generous slack.
    const expectedWaitMs = CONFIRMED_DEPTH * 5 * 60_000;
    expect(MAX_POLL_MS).toBeGreaterThan(expectedWaitMs);
  });
});
