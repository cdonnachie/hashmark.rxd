/**
 * A small per-IP token bucket for the read-only API routes.
 *
 * In-memory and per-process, so it is a courtesy limit rather than a security
 * control — behind several instances each keeps its own count. That is an
 * acceptable trade here because these routes are a convenience wrapper over
 * public blockchain data: there is nothing behind them worth defending, and the
 * real protection for the upstream node is its own limiter.
 *
 * A production deployment should also rate-limit at nginx (see README).
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Discard expired buckets so a long-running process does not grow unbounded. */
function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetSeconds: number;
}

export function rateLimit(key: string): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetSeconds: WINDOW_MS / 1000 };
  }

  existing.count += 1;
  const resetSeconds = Math.ceil((existing.resetAt - now) / 1000);
  return {
    allowed: existing.count <= MAX_REQUESTS,
    remaining: Math.max(0, MAX_REQUESTS - existing.count),
    resetSeconds,
  };
}

/**
 * Best-effort client identity.
 *
 * Only the first hop of `x-forwarded-for` is used, and only the address — never
 * stored, never logged, never combined with anything else.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: {
        "retry-after": String(result.resetSeconds),
        "cache-control": "no-store",
      },
    },
  );
}
