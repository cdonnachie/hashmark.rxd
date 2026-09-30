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

/**
 * RXinDexer REST endpoints, tried in order, comma-separated.
 *
 * Several are allowed for the same reason several Radiant nodes are: an index
 * that cannot be reached must degrade to "cannot search", and one reachable
 * spare turns that outage into a slower answer instead. A single URL is still
 * the common case and needs no commas.
 *
 * They are NOT cross-checked against each other. The index is a hint and every
 * hit is re-fetched and re-decoded against the chain, so agreement between two
 * indexes would prove nothing that re-verification does not already prove. What
 * failover buys is availability, which is the only thing at risk here.
 */
const INDEX_URLS: readonly string[] = (process.env.HASHMARK_INDEX_URL ?? "")
  .split(",")
  .map((entry) => entry.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/**
 * Short by design, and per endpoint. A verifier is waiting on this, and a slow
 * index must fail loudly as "cannot search" rather than hang until the page
 * looks broken. With two endpoints the worst case is twice this, which is why
 * it is not generous.
 */
const TIMEOUT_MS = 5_000;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const TXID_RE = /^[0-9a-f]{64}$/;

/** Whether any index address is configured at all. */
export const indexConfigured = INDEX_URLS.length > 0;

/**
 * Every failure mode collapses to {@link HashMarkLookupUnavailable}: not
 * configured, unreachable, timed out, non-200, unparseable. That is the point —
 * the one answer this function must never produce by accident is an empty list,
 * because "the index is down" would then read to a user as "your file was
 * never marked".
 */
async function indexGet(path: string): Promise<unknown> {
  if (!indexConfigured) throw new HashMarkLookupUnavailable();

  for (const base of INDEX_URLS) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      // Unreachable or timed out. The upstream error is deliberately not
      // propagated even to the next iteration's log: it carries the internal
      // hostname.
      continue;
    }

    if (!response.ok) continue;

    try {
      return await response.json();
    } catch {
      // Answered, but not with JSON. Treat it as broken and try the next.
      continue;
    }
  }

  // Every endpoint failed. Note what this does NOT do: a well-formed empty
  // result from the first endpoint is returned as-is and never retried
  // elsewhere. "[]" means "not marked", which is the common answer, and
  // shopping it around would turn the ordinary case into a request to every
  // server while making an empty list look like a failure.
  throw new HashMarkLookupUnavailable();
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
