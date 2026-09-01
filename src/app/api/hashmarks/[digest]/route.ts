import { indexStatus, lookupDigest } from "@/lib/hashmark-index";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { withChain } from "@/lib/radiant/server";
import { HashMarkLookupUnavailable, searchDigest } from "@/lib/verify";

/**
 * Look up marks by digest.
 *
 * The digest index (RXinDexer's `/hashmark/{digest}`) supplies hints only.
 * Every hit is re-fetched from a Radiant node and re-decoded before being
 * returned, so a wrong answer from the index becomes a missing result rather
 * than a false one.
 *
 * A digest is a linkable identifier for a file, so nothing here is logged and
 * responses are marked private.
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

    // An index that is running but has HashMark indexing switched off answers
    // every lookup with an empty list. That is not "nothing found".
    if (status?.enabled === false) throw new HashMarkLookupUnavailable();

    // No hints, no reason to open a connection to a node.
    const { marks, rejected } =
      hits.length === 0
        ? { marks: [], rejected: 0 }
        : await withChain((chain) => searchDigest(chain, clean, async () => hits));

    return Response.json(
      {
        digest: clean,
        found: marks.length,
        rejected,
        // False means the index has not scanned the whole chain yet, so an
        // empty result is "not found so far", not "never marked".
        backfillComplete: status?.backfillComplete ?? null,
        marks: marks.map((mark) => ({
          transactionId: mark.txid,
          outputIndex: mark.outputIndex,
          state: mark.state,
          confirmations: mark.confirmations,
          blockTime: mark.blockTime ?? null,
          label: mark.record.label ?? null,
          version: mark.record.version,
          // Present only when a v2 signature verified against the signer the
          // record commits to. Null on a v1 mark, which carries no signer at
          // all — never null because a check was skipped, since a record whose
          // signature fails is not returned as a mark.
          signer: mark.signer ?? null,
        })),
      },
      { headers: { "cache-control": "private, max-age=15" } },
    );
  } catch (error) {
    if (error instanceof HashMarkLookupUnavailable) {
      // 501, not 404: "we cannot search" must never be mistaken for "no mark".
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
