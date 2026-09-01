"use client";

import Link from "next/link";
import { useState } from "react";

import { DropZone, type HashedFile } from "@/components/drop-zone";
import { MarkResult } from "@/components/mark-result";
import { useTrackedTransaction } from "@/lib/use-tracked-transaction";
import { compareDigest, type TransactionVerification } from "@/lib/verify";

/**
 * Fetches and decodes a transaction in the browser, so the result comes from a
 * Radiant node rather than from this site's server. A user can check the same
 * transaction with any other Radiant tool and get the same answer.
 */
export function TxVerifier({ txid }: { txid: string }) {
  const [file, setFile] = useState<HashedFile | null>(null);
  // Polls until the transaction settles, so a page opened moments after a
  // broadcast fills in its confirmation count instead of freezing on zero.
  const { state, refreshing, settled, refresh } = useTrackedTransaction(txid);

  if (state.kind === "loading") {
    return (
      <p className="mt-8 text-sm text-muted" aria-live="polite">
        Reading this transaction from a Radiant node…
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        role="alert"
        className="mt-8 rounded-lg border border-alert/50 bg-alert/10 p-5 sm:p-6"
      >
        <p className="font-display text-sm font-semibold text-alert">
          Could not read this transaction
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {state.message}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="mt-4 rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
        >
          Try again
        </button>
      </div>
    );
  }

  const { marks, problems } = state.verification;

  if (marks.length === 0) {
    return (
      <div className="mt-8 space-y-6">
        <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
          <p className="font-display text-sm font-semibold text-text">
            This transaction exists, but carries no HashMark
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            It is a real Radiant transaction. None of its outputs contains a
            HashMark record, so there is nothing here to verify a file against.
          </p>
        </div>
        {problems.length > 0 && <Problems problems={problems} />}
        <Link
          href="/verify"
          className="inline-block text-sm text-chain underline underline-offset-4 hover:opacity-80"
        >
          Verify a file instead
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        {marks.length > 1 && (
          <p className="text-sm text-muted">
            This transaction carries {marks.length} HashMark records.
          </p>
        )}
        {!settled && (
          <p className="text-xs text-faint" aria-live="polite">
            {refreshing
              ? "Checking for new confirmations…"
              : "Rechecking automatically until this settles."}
          </p>
        )}
      </div>

      {marks.map((mark) => (
        <MarkResult
          key={`${mark.txid}:${mark.outputIndex}`}
          mark={mark}
          localDigest={file?.digest}
          match={compareDigest(mark, file?.digest)}
        />
      ))}

      {problems.length > 0 && <Problems problems={problems} />}

      <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <h2 className="font-display text-sm font-semibold text-text">
          Check a file against this mark
        </h2>
        <p className="mt-2 mb-5 text-sm leading-relaxed text-muted">
          Optional. Choose the file you believe this mark records, and its
          fingerprint will be compared here in your browser.
        </p>
        <DropZone
          onHashed={setFile}
          onCleared={() => setFile(null)}
          compact
          idle="Drop the file to compare"
          hint="Hashed on your device — never uploaded"
        />
      </section>
    </div>
  );
}

/**
 * Malformed records are shown rather than hidden. Someone following a link to
 * this transaction deserves to know an output claimed to be a HashMark and
 * could not be read, instead of seeing a silent absence.
 */
function Problems({
  problems,
}: {
  problems: TransactionVerification["problems"];
}) {
  return (
    <div className="rounded-lg border border-caution/40 bg-caution/5 p-5 sm:p-6">
      <p className="font-display text-sm font-semibold text-caution">
        {problems.length === 1
          ? "One output could not be read"
          : `${problems.length} outputs could not be read`}
      </p>
      <ul className="mt-3 space-y-2 text-sm text-muted">
        {problems.map((problem) => (
          <li key={problem.index}>
            <span className="digest text-text">Output {problem.index}</span>
            {": "}
            {problem.kind === "attestation" ? (
              problem.reason === "SIGNER_MISMATCH" ? (
                <>
                  a readable HashMark whose signature does not belong to the
                  signer it names. The record is not corrupt — its claim does
                  not hold, so it is not shown as a mark.
                </>
              ) : (
                <>signature could not be checked — {problem.detail}.</>
              )
            ) : problem.result.reason === "UNKNOWN_VERSION" ? (
              <>
                a HashMark of version {problem.result.observedVersion}, which
                this verifier does not implement. It is a newer kind of record,
                not a broken one, and is deliberately not read as an older
                version.
              </>
            ) : problem.result.reason === "UNKNOWN_ALGORITHM" ? (
              <>
                uses hash algorithm {problem.result.observedAlgorithmId}, which
                this verifier does not know.
              </>
            ) : (
              <>malformed record — {problem.result.detail}.</>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
