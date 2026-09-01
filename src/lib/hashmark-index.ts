/**
 * The HashMark digest index, over RXinDexer's REST API.
 *
 * Digest search is the one HashMark operation no plain Radiant node can serve
 * (docs/RXINDEXER_HASHMARK_INDEX.md). RXinDexer now indexes HashMark outputs
 * and exposes them at `GET /hashmark/{digest}`, so this module is the whole of
 * HashMark's dependency on it: two GETs, no writes, no authentication.
 *
 * **Server-side only, deliberately.** The indexer sits on a private network,
 * and `HASHMARK_INDEX_URL` is not a `NEXT_PUBLIC_` variable, so its address is
 * never inlined into the browser bundle. Browsers reach the index through this
 * application's own `/api/hashmarks/*` routes instead — and then re-verify
 * every hit against a Radiant node directly, which is what keeps this site out
 * of the trust path even though it now sits in the search path.
 *
 * The index is a **hint source, never evidence**. Nothing here is returned to a
 * user as a finding: `searchDigest` re-fetches and re-decodes each hit
 * (HASHMARK_PROTOCOL.md §2.8), so a compromised or lagging index can cost us a
 * result but can never invent one.
 */
import "server-only";

import { HashMarkLookupUnavailable, type IndexHit } from "@/lib/verify";

/** Base URL of the RXinDexer REST API, e.g. `http://10.0.0.5:8000`. */
const INDEX_URL = (process.env.HASHMARK_INDEX_URL ?? "").replace(/\/+$/, "");

/**
 * Short by design. A verifier is waiting on this, and a slow index must fail
 * loudly as "cannot search" rather than hang until the page looks broken.
 */
const TIMEOUT_MS = 5_000;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const TXID_RE = /^[0-9a-f]{64}$/;

/** Whether an index address is configured at all. */
export const indexConfigured = INDEX_URL !== "";

/**
 * Every failure mode collapses to {@link HashMarkLookupUnavailable}: not
 * configured, unreachable, timed out, non-200, unparseable. That is the point —
 * the one answer this function must never produce by accident is an empty list,
 * because "the index is down" would then read to a user as "your file was
 * never marked".
 */
async function indexGet(path: string): Promise<unknown> {
  if (!indexConfigured) throw new HashMarkLookupUnavailable();

  let response: Response;
  try {
    response = await fetch(`${INDEX_URL}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // The upstream error is not propagated: it carries the internal hostname.
    throw new HashMarkLookupUnavailable();
  }

  if (!response.ok) throw new HashMarkLookupUnavailable();

  try {
    return await response.json();
  } catch {
    throw new HashMarkLookupUnavailable();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Parse a lookup response into hints.
 *
 * Only `txid` is required, and anything without a well-formed one is dropped
 * rather than passed on — a malformed hit is worthless to us, since it cannot
 * be re-verified against the chain anyway.
 */
export function parseIndexHits(raw: unknown): IndexHit[] {
  if (!Array.isArray(raw)) throw new HashMarkLookupUnavailable();

  return raw.flatMap((entry) => {
    const hit = asRecord(entry);
    if (!hit) return [];

    const txid = hit["txid"];
    if (typeof txid !== "string" || !TXID_RE.test(txid.toLowerCase())) return [];

    const outputIndex = hit["output_index"];
    const height = hit["height"];

    return [
      {
        txid: txid.toLowerCase(),
        outputIndex:
          typeof outputIndex === "number" && Number.isInteger(outputIndex)
            ? outputIndex
            : 0,
        height: typeof height === "number" ? height : 0,
      },
    ];
  });
}

/**
 * Hints for one digest, oldest first.
 *
 * An empty array is a real answer: the digest was never marked, as far as the
 * index has scanned. Check {@link indexStatus} to know how far that is.
 */
export async function lookupDigest(
  digest: string,
  options: { limit?: number } = {},
): Promise<IndexHit[]> {
  if (!DIGEST_RE.test(digest)) {
    // Never interpolate an unvalidated digest into the request path.
    throw new Error("digest must be 64 lowercase hex characters");
  }

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const raw = await indexGet(
    `/hashmark/${digest}?algorithm=sha256&limit=${limit}`,
  );
  return parseIndexHits(raw);
}

export interface IndexStatus {
  /** False when RXinDexer is running but its HashMark index is switched off. */
  readonly enabled: boolean;
  /**
   * Whether the historic backfill has finished. While false, an empty lookup
   * means "not scanned back that far yet" and must not be presented as "never
   * marked".
   */
  readonly backfillComplete: boolean;
  /** Oldest height scanned so far, or null when the index does not say. */
  readonly backfillNextHeight: number | null;
  readonly backfillTargetHeight: number | null;
}

/**
 * Index status, or `null` when it cannot be asked.
 *
 * Returns rather than throws: the status is a qualifier on a result, and not
 * knowing it should soften what we claim, not fail the search.
 */
export async function indexStatus(): Promise<IndexStatus | null> {
  let raw: unknown;
  try {
    raw = await indexGet("/hashmark/stats");
  } catch {
    return null;
  }

  const stats = asRecord(raw);
  if (!stats) return null;

  const asHeight = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) ? value : null;

  return {
    // Only an explicit `false` counts as disabled: an index that answers
    // lookups but reports a different stats shape is still a working index.
    enabled: stats["enabled"] !== false,
    // Completeness is the other way round — claimed, or not assumed.
    backfillComplete: stats["backfill_complete"] === true,
    backfillNextHeight: asHeight(stats["backfill_next_height"]),
    backfillTargetHeight: asHeight(stats["backfill_target_height"]),
  };
}
