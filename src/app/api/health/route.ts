import { NETWORK } from "@/lib/config";
import { indexConfigured, indexStatus } from "@/lib/hashmark-index";
import { withChain } from "@/lib/radiant/server";

/**
 * Service health.
 *
 * Reports enough to be useful to a monitor and nothing more: no server paths,
 * no versions of anything an attacker could fingerprint, no upstream hostnames,
 * and no request details. "Can we reach the chain, and how far along is it."
 *
 * `search` covers the digest index, which is a separate machine and a separate
 * failure: fingerprint search stops working without it, everything else carries
 * on. It is reported, never fatal — an operator who has not set
 * `HASHMARK_INDEX_URL` sees `not-configured` here rather than having to guess
 * why /verify says search is unavailable.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const startedAt = Date.now();

  // The index is asked alongside the chain, never in front of it: a slow or
  // missing indexer must not delay or fail the chain answer.
  const index = indexConfigured ? indexStatus() : Promise.resolve(null);

  try {
    const height = await withChain((chain) => chain.tipHeight());
    const status = await index;
    return Response.json(
      {
        status: "ok",
        network: NETWORK.id,
        chainTip: height,
        latencyMs: Date.now() - startedAt,
        search: !indexConfigured
          ? "not-configured"
          : status?.enabled
            ? "ok"
            : "unavailable",
        backfillComplete: status?.backfillComplete ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // The upstream error is deliberately not echoed: it can carry hostnames
    // and connection detail that a health endpoint should not publish.
    return Response.json(
      {
        status: "degraded",
        network: NETWORK.id,
        chainTip: null,
        latencyMs: Date.now() - startedAt,
        search: indexConfigured ? "unknown" : "not-configured",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
