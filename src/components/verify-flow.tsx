"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { ByteGrid } from "@/components/byte-grid";
import { DropZone, type HashedFile } from "@/components/drop-zone";
import { MarkResult } from "@/components/mark-result";
import { formatBytes } from "@/lib/hashing/digest";
import { searchDigestFromBrowser } from "@/lib/hashmark-search";
import { HashMarkLookupUnavailable, type VerifiedMark } from "@/lib/verify";

/**
 * Verify a local file against the chain.
 *
 * Three outcomes have to stay distinct, because conflating them would mislead:
 *
 *   found      — one or more marks, each re-verified against the chain.
 *   none       — searched successfully, nothing recorded this file. NOT proof
 *                of anything being wrong with the file.
 *   unsearchable — no connected node offers digest search. This is our problem,
 *                not a statement about the file, and it must never be shown as
 *                "no match found".
 */
type Outcome =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; marks: readonly VerifiedMark[]; rejected: number }
  | { kind: "none"; backfillComplete: boolean | null }
  | { kind: "unsearchable"; message: string }
  | { kind: "error"; message: string };

/**
 * What to say when a file has more than one mark.
 *
 * Marks by different keys are the case this matters for. They are not ranked,
 * and the earliest is not called canonical: which one counts depends on whose
 * key the reader expected, and that is not something the chain can answer. The
 * timestamp claim is unaffected either way — the earliest confirmed mark is
 * still evidence the file existed by then, whoever made it.
 */
function signerSummary(marks: readonly VerifiedMark[]): string {
  const signers = new Set(
    marks.map((mark) => mark.signer).filter((signer) => signer !== undefined),
  );
  const unsigned = marks.some((mark) => mark.signer === undefined);

  if (signers.size > 1) {
    return `${marks.length} marks record this file, signed by different keys. Which one you should rely on depends on whose key you expected — that is not something the chain can answer.`;
  }
  if (signers.size === 1 && !unsigned) {
    return `${marks.length} marks record this file, all signed by the same key.`;
  }
  if (signers.size === 1) {
    // One signer plus older unsigned records. Worth saying plainly, because
    // "no signature" here means the record predates signed attestations — not
    // that anything failed a check.
    const older = marks.length - 1;
    return `${marks.length} marks record this file. One names the key that signed it; ${
      older === 1 ? "the other predates" : `the other ${older} predate`
    } signed attestations and can only show when.`;
  }
  return `${marks.length} marks record this file, none of them signed — each shows when, not who. The earliest confirmed one is the earliest evidence the file existed.`;
}

export function VerifyFlow() {
  const [file, setFile] = useState<HashedFile | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  const search = useCallback(async (hashed: HashedFile) => {
    setFile(hashed);
    setOutcome({ kind: "searching" });

    try {
      const { marks, rejected, backfillComplete } =
        await searchDigestFromBrowser(hashed.digest);
      setOutcome(
        marks.length > 0
          ? { kind: "found", marks, rejected }
          : { kind: "none", backfillComplete },
      );
    } catch (error) {
      if (error instanceof HashMarkLookupUnavailable) {
        setOutcome({ kind: "unsearchable", message: error.message });
      } else {
        setOutcome({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not reach a Radiant node.",
        });
      }
    }
  }, []);

  return (
    <div className="space-y-8">
      <DropZone
        onHashed={search}
        onCleared={() => {
          setFile(null);
          setOutcome({ kind: "idle" });
        }}
        idle="Drop a file to check it"
        hint="Hashed here in your browser — never uploaded"
      />

      {file && (
        <section aria-live="polite" className="space-y-6">
          <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <p className="eyebrow">Fingerprint of your file</p>
              <p className="text-xs text-muted">
                <span className="text-text">{file.name}</span> ·{" "}
                {formatBytes(file.size)}
              </p>
            </div>
            <ByteGrid
              digest={file.digest}
              tone="local"
              label="The fingerprint of the file you chose"
            />
          </div>

          {outcome.kind === "searching" && (
            <p className="text-sm text-muted">
              Searching the Radiant chain for this fingerprint…
            </p>
          )}

          {outcome.kind === "found" && (
            <div className="space-y-6">
              <p className="text-sm text-muted">
                {outcome.marks.length === 1
                  ? "One mark records this file."
                  : signerSummary(outcome.marks)}
                {outcome.rejected > 0 && (
                  <>
                    {" "}
                    <span className="text-faint">
                      ({outcome.rejected}{" "}
                      {outcome.rejected === 1 ? "result" : "results"} from the
                      search index did not match the chain and{" "}
                      {outcome.rejected === 1 ? "was" : "were"} discarded.)
                    </span>
                  </>
                )}
              </p>
              {outcome.marks.map((mark) => (
                <MarkResult
                  key={`${mark.txid}:${mark.outputIndex}`}
                  mark={mark}
                  localDigest={file.digest}
                  match="match"
                />
              ))}
            </div>
          )}

          {outcome.kind === "none" && (
            <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
              <p className="font-display text-sm font-semibold text-text">
                No matching HashMark found
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Nothing on the Radiant chain records this exact file. That is
                simply an absence of a record — it says nothing about whether the
                file is genuine, and it is the expected result for any file that
                was never marked.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                If you expected a match, the most common reasons are that the
                file was edited or re-saved after it was marked, or that a
                different copy was marked.
              </p>
              {outcome.backfillComplete === false && (
                <p className="mt-3 text-sm leading-relaxed text-caution">
                  One caveat: the search index is still working backwards
                  through older blocks, so it has not read the whole chain yet.
                  A mark made long ago may not be findable by fingerprint until
                  that finishes — it is still verifiable by transaction id or
                  receipt in the meantime.
                </p>
              )}
              <Link
                href="/create"
                className="mt-4 inline-block rounded bg-chain px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
              >
                Create a mark for this file
              </Link>
            </div>
          )}

          {outcome.kind === "unsearchable" && (
            <div className="rounded-lg border border-caution/50 bg-caution/10 p-5 sm:p-6">
              <p className="font-display text-sm font-semibold text-caution">
                Search is unavailable right now
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {outcome.message} This is a limitation of the search index,
                not a result about your file — do not read it as &ldquo;no mark
                found&rdquo;.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                If you have the transaction id or a receipt, you can still verify
                this file completely:
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href="/receipt"
                  className="rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
                >
                  Import a receipt
                </Link>
              </div>
            </div>
          )}

          {outcome.kind === "error" && (
            <div
              role="alert"
              className="rounded-lg border border-alert/50 bg-alert/10 p-5 sm:p-6"
            >
              <p className="font-display text-sm font-semibold text-alert">
                Could not complete the search
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {outcome.message}
              </p>
              <button
                type="button"
                onClick={() => void search(file)}
                className="mt-4 rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
              >
                Try again
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
