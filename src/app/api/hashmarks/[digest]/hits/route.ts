import { indexStatus, lookupDigest } from "@/lib/hashmark-index";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { HashMarkLookupUnavailable } from "@/lib/verify";

/**
 * Raw search hints for a digest — what the index says, nothing more.
 *
 * This exists because the index is on a private network and a browser cannot
 * reach it. The browser asks us for pointers and then re-fetches and re-decodes
 * every one of them against a Radiant node **itself**, so this site sits in the
 * search path without sitting in the trust path: the worst a compromised
 * HashMark server can do here is withhold pointers or send useless ones, never
 * manufacture a verification.
 *
 * `/api/hashmarks/{digest}` is the verified answer, for callers that would
 * rather we did the chain work for them.
 */
export const dynamic = "force-dynamic";

const DIGEST_RE = /^[0-9a-f]{64}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ digest: string }> },
): Promise<Response> {
  const limit = rateLimit(clientKey(request));
  if (!limit.allowed) return tooManyRequests(limit);

  const { digest } = await context.params;
  const clean = digest.trim().toLowerCase();

  if (!DIGEST_RE.test(clean)) {
    return Response.json(
      {
        error:
          "A digest must be 64 lowercase hexadecimal characters. Partial digests are not accepted.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const [status, hits] = await Promise.all([
      indexStatus(),
      lookupDigest(clean),
    ]);

    if (status?.enabled === false) throw new HashMarkLookupUnavailable();

    return Response.json(
      {
        digest: clean,
        backfillComplete: status?.backfillComplete ?? null,
        hits: hits.map((hit) => ({
          transactionId: hit.txid,
          outputIndex: hit.outputIndex,
          height: hit.height,
        })),
      },
      { headers: { "cache-control": "private, max-age=15" } },
    );
  } catch (error) {
    if (error instanceof HashMarkLookupUnavailable) {
      return Response.json(
        { error: error.message, searchable: false },
        { status: 501, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      { error: "Could not complete the search." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
