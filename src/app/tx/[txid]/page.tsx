import type { Metadata } from "next";
import Link from "next/link";

import { TxVerifier } from "@/components/tx-verifier";
import { isTxid } from "@/lib/radiant/chain";

/**
 * Verification by transaction id.
 *
 * Next.js 16: `params` is a Promise and must be awaited — synchronous access
 * was removed in this major version.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ txid: string }>;
}): Promise<Metadata> {
  const { txid } = await params;
  const clean = txid.toLowerCase();
  return {
    title: isTxid(clean)
      ? `Transaction ${clean.slice(0, 12)}…`
      : "Invalid transaction id",
    description:
      "Look up a HashMark record by its Radiant transaction id and check its confirmation state.",
    // A transaction page is a lookup result, not content worth indexing, and
    // indexing it would publish a digest-to-URL mapping we have no reason to.
    robots: { index: false, follow: false },
  };
}

export default async function TransactionPage({
  params,
}: {
  params: Promise<{ txid: string }>;
}) {
  const { txid } = await params;
  const clean = txid.trim().toLowerCase();

  // Validated before it reaches any query. A transaction id from a URL is
  // untrusted input like any other.
  if (!isTxid(clean)) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          That is not a transaction id
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
          A Radiant transaction id is exactly 64 hexadecimal characters. The
          value in this address is not, so there is nothing to look up.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/verify"
            className="rounded bg-chain px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
          >
            Verify a file instead
          </Link>
          <Link
            href="/receipt"
            className="rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
          >
            Import a receipt
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <p className="eyebrow">Transaction</p>
      <h1 className="digest mt-2 text-lg font-medium break-all text-text sm:text-xl">
        {clean}
      </h1>
      <TxVerifier txid={clean} />
    </div>
  );
}
