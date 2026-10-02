import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isTxid } from "@/lib/radiant/chain";
import { withChain } from "@/lib/radiant/server";
import { verifyTransaction } from "@/lib/verify";

/**
 * Parsed HashMark records for a transaction.
 *
 * A convenience for clients that cannot open a WebSocket. The browser does not
 * use it: it talks to a Radiant node directly, so that verification never
 * depends on this server being honest or even present.
 *
 * Next.js 16: route `params` is a Promise and must be awaited.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ txid: string }> },
): Promise<Response> {
  const limit = rateLimit(clientKey(request));
  if (!limit.allowed) return tooManyRequests(limit);

  const { txid } = await context.params;
  const clean = txid.trim().toLowerCase();

  if (!isTxid(clean)) {
    return Response.json(
      { error: "A transaction id must be 64 lowercase hexadecimal characters." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const { transaction, marks, problems } = await withChain((chain) =>
      verifyTransaction(chain, clean),
    );

    return Response.json(
      {
        transactionId: transaction.txid,
        confirmations: transaction.confirmations,
        state: transaction.state,
        blockHash: transaction.blockHash ?? null,
        blockTime: transaction.blockTime ?? null,
        marks: marks.map((mark) => ({
          outputIndex: mark.outputIndex,
          version: mark.record.version,
          algorithm: mark.record.algorithm,
          digest: mark.record.digest,
          label: mark.record.label ?? null,
          signer: mark.signer ?? null,
          blockProof: mark.inclusion?.kind ?? "unproved",
        })),
        problems: problems.map((problem) => ({
          outputIndex: problem.index,
          // "could not be read" and "its signature did not hold up" are
          // different answers, and a caller should be able to tell them apart.
          kind: problem.kind,
          reason:
            problem.kind === "decode" ? problem.result.reason : problem.reason,
        })),
      },
      {
        headers: {
          // A confirmed transaction never changes, but its confirmation count
          // does, so this is cached only briefly.
          "cache-control": "public, max-age=15",
        },
      },
    );
  } catch (error) {
    // A transaction that does not exist is a 404, not an upstream failure. The
    // node reports it as an error, so the two have to be told apart here.
    const message = error instanceof Error ? error.message : "";
    if (/no such|not found|missing/i.test(message)) {
      return Response.json(
        { error: "No transaction with that id exists on this chain." },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      { error: "Could not read that transaction from a Radiant node." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
