"use client";

import { browserChain } from "@/lib/radiant/client";
import {
  HashMarkLookupUnavailable,
  searchDigest,
  type DigestSearchResult,
  type IndexHit,
} from "@/lib/verify";

/**
 * Search the chain for a digest, from the browser.
 *
 * Split deliberately in two, because the two halves have very different trust
 * requirements:
 *
 *   the hints — fetched from this site's `/api/hashmarks/{digest}/hits`, which
 *     forwards to the RXinDexer digest index. The index lives on a private
 *     network, so a browser cannot query it directly.
 *   the answer — computed here, by fetching each hinted transaction from a
 *     Radiant node **directly** and re-decoding its outputs.
 *
 * So this site can point the browser at transactions, but it cannot say what
 * they contain. A tampered hint list produces a missing or discarded result,
 * never a fabricated one.
 */
export interface BrowserSearchResult extends DigestSearchResult {
  /**
   * Whether the index has finished scanning historic blocks. `null` when it did
   * not say. While false, "no marks" means "none found in what has been scanned
   * so far" — a weaker claim, and the interface says so.
   */
  readonly backfillComplete: boolean | null;
}

export async function searchDigestFromBrowser(
  digest: string,
): Promise<BrowserSearchResult> {
  let backfillComplete: boolean | null = null;

  const result = await searchDigest(browserChain(), digest, async (value) => {
    const response = await fetch(
      `/api/hashmarks/${encodeURIComponent(value)}/hits`,
      { headers: { accept: "application/json" } },
    );

    if (response.status === 501) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };
      throw new HashMarkLookupUnavailable(
        typeof body.error === "string" ? body.error : undefined,
      );
    }
    if (!response.ok) {
      throw new Error("The search index could not be reached.");
    }

    const body = (await response.json()) as {
      backfillComplete?: unknown;
      hits?: unknown;
    };
    backfillComplete =
      typeof body.backfillComplete === "boolean" ? body.backfillComplete : null;

    if (!Array.isArray(body.hits)) return [];

    return body.hits.flatMap((entry): IndexHit[] => {
      const hit = entry as Record<string, unknown>;
      const txid = hit["transactionId"];
      if (typeof txid !== "string") return [];
      return [
        {
          txid,
          outputIndex:
            typeof hit["outputIndex"] === "number" ? hit["outputIndex"] : 0,
          height: typeof hit["height"] === "number" ? hit["height"] : 0,
        },
      ];
    });
  });

  return { ...result, backfillComplete };
}
