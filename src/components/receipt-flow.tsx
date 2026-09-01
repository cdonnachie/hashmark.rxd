"use client";

import { useCallback, useRef, useState } from "react";

import { MAX_RECEIPT_BYTES, networkById, parseReceipt } from "@hashmark/protocol";
import type { HashMarkReceipt } from "@hashmark/protocol";

import { DropZone, type HashedFile } from "@/components/drop-zone";
import { MarkResult } from "@/components/mark-result";
import { NETWORK } from "@/lib/config";
import { browserChain } from "@/lib/radiant/client";
import { compareDigest, verifyTransaction, type VerifiedMark } from "@/lib/verify";

/**
 * Import and check a HashMark receipt.
 *
 * The order of operations is the whole point. The receipt is parsed only to
 * learn *where to look*; then the transaction is fetched and decoded, and every
 * value displayed afterwards comes from the chain. Where the receipt disagrees
 * with the chain, the disagreement is reported and the chain wins.
 */

interface Disagreement {
  readonly field: string;
  readonly claimed: string;
  readonly actual: string;
}

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "verified";
      mark: VerifiedMark;
      receipt: HashMarkReceipt;
      disagreements: readonly Disagreement[];
    }
  | { kind: "invalid"; errors: readonly string[] }
  | { kind: "error"; message: string };

export function ReceiptFlow() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [text, setText] = useState("");
  const [file, setFile] = useState<HashedFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * The file-versus-chain comparison, derived once.
   *
   * Used by the result banner and by the note beside the drop zone, so the two
   * can never disagree about the same file.
   */
  const fileMatch =
    state.kind === "verified" && file
      ? compareDigest(state.mark, file.digest)
      : "not-compared";

  const check = useCallback(async (raw: string) => {
    setState({ kind: "checking" });

    const parsed = parseReceipt(raw);
    if (!parsed.ok) {
      setState({ kind: "invalid", errors: parsed.errors });
      return;
    }
    const receipt = parsed.receipt;

    // The receipt names a chain. If it is not the chain this build talks to,
    // stop: verifying a testnet receipt against mainnet would be meaningless.
    const network = networkById(receipt.network);
    if (network === undefined || network.genesisHash !== NETWORK.genesisHash) {
      setState({
        kind: "invalid",
        errors: [
          `This receipt is for ${receipt.network}, but this site verifies against ${NETWORK.id}. A mark on one chain says nothing about another.`,
        ],
      });
      return;
    }

    try {
      const { marks } = await verifyTransaction(
        browserChain(),
        receipt.transactionId,
      );
      const mark = marks.find((m) => m.outputIndex === receipt.outputIndex);

      if (!mark) {
        setState({
          kind: "invalid",
          errors: [
            `The transaction exists, but output ${receipt.outputIndex} does not contain a readable HashMark. This receipt points at something that is not a mark.`,
          ],
        });
        return;
      }

      // Everything the receipt claims, checked against what the chain says.
      const disagreements: Disagreement[] = [];
      if (mark.record.digest !== receipt.digest) {
        disagreements.push({
          field: "Fingerprint",
          claimed: receipt.digest,
          actual: mark.record.digest,
        });
      }
      if (mark.record.algorithm !== receipt.algorithm) {
        disagreements.push({
          field: "Algorithm",
          claimed: receipt.algorithm,
          actual: mark.record.algorithm,
        });
      }
      if ((mark.record.label ?? "") !== (receipt.label ?? "")) {
        disagreements.push({
          field: "Label",
          claimed: receipt.label ?? "(none)",
          actual: mark.record.label ?? "(none)",
        });
      }
      // The receipt says who the reader should expect. The chain says who
      // actually signed. A mismatch is reported, never treated as grounds to
      // reject the mark — and a matching expectation is not evidence either,
      // since anyone can write a receipt.
      if (
        receipt.expectedSigner !== undefined &&
        receipt.expectedSigner !== mark.signer
      ) {
        disagreements.push({
          field: "Expected signer",
          claimed: receipt.expectedSigner,
          actual: mark.signer ?? "(this record carries no signature)",
        });
      }

      setState({ kind: "verified", mark, receipt, disagreements });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not reach a Radiant node.",
      });
    }
  }, []);

  const readFile = useCallback(
    async (chosen: File) => {
      if (chosen.size > MAX_RECEIPT_BYTES) {
        setState({
          kind: "invalid",
          errors: [`A receipt should be under ${MAX_RECEIPT_BYTES} bytes.`],
        });
        return;
      }
      const raw = await chosen.text();
      setText(raw);
      await check(raw);
    },
    [check],
  );

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">Receipt file</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded border border-line-bright bg-raised px-3.5 py-1.5 text-xs font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
          >
            Choose a .json receipt
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          aria-label="Choose a HashMark receipt file"
          className="sr-only"
          onChange={(event) => {
            const chosen = event.target.files?.item(0);
            if (chosen) void readFile(chosen);
            event.target.value = "";
          }}
        />

        <label htmlFor="receipt-text" className="mt-5 mb-2 block text-sm text-muted">
          Or paste the receipt here
        </label>
        <textarea
          id="receipt-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={'{\n  "format": "hashmark-receipt",\n  "version": 1,\n  …\n}'}
          className="digest w-full rounded border border-line bg-ink p-3 text-xs text-text placeholder:text-faint"
        />
        <button
          type="button"
          onClick={() => void check(text)}
          disabled={text.trim().length === 0 || state.kind === "checking"}
          className="mt-3 rounded bg-chain px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.kind === "checking" ? "Checking the chain…" : "Check this receipt"}
        </button>

        <p className="mt-4 text-xs leading-relaxed text-faint">
          A receipt is only a pointer. Nothing in it is trusted: the transaction
          it names is fetched from Radiant and everything shown below is read
          from the chain.
        </p>
      </div>

      <div aria-live="polite" className="space-y-6">
        {state.kind === "invalid" && (
          <div
            role="alert"
            className="rounded-lg border border-alert/50 bg-alert/10 p-5 sm:p-6"
          >
            <p className="font-display text-sm font-semibold text-alert">
              This receipt does not check out
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted">
              {state.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {state.kind === "error" && (
          <div
            role="alert"
            className="rounded-lg border border-alert/50 bg-alert/10 p-5 sm:p-6"
          >
            <p className="font-display text-sm font-semibold text-alert">
              Could not check this receipt
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {state.message}
            </p>
          </div>
        )}

        {state.kind === "verified" && (
          <>
            {state.disagreements.length > 0 && (
              <div className="rounded-lg border border-alert/50 bg-alert/10 p-5 sm:p-6">
                <p className="font-display text-sm font-semibold text-alert">
                  The receipt disagrees with the chain
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  The transaction is real, but this receipt misstates what it
                  records. Trust the chain values below, not the receipt.
                </p>
                <dl className="mt-4 space-y-3 text-xs">
                  {state.disagreements.map((d) => (
                    <div key={d.field}>
                      <dt className="eyebrow mb-1">{d.field}</dt>
                      <dd className="digest break-all text-muted">
                        receipt claims {d.claimed}
                      </dd>
                      <dd className="digest break-all text-text">
                        chain says {d.actual}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {state.disagreements.length === 0 && (
              <p className="text-sm text-muted">
                Every claim in the receipt matches the chain.
                {state.receipt.expectedSigner !== undefined &&
                  state.mark.signer !== undefined &&
                  " Expected signer found."}
              </p>
            )}

            <MarkResult
              mark={state.mark}
              localDigest={file?.digest}
              match={fileMatch}
            />

            <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
              <h2 className="font-display text-sm font-semibold text-text">
                Check the file too
              </h2>
              <p className="mt-2 mb-5 text-sm leading-relaxed text-muted">
                Optional, and the step that actually ties the mark to a document.
                Choose the file this receipt is for.
              </p>
              <DropZone
                onHashed={setFile}
                onCleared={() => setFile(null)}
                compact
                idle="Drop the file this receipt is for"
                hint="Hashed on your device — never uploaded"
              />

              {/*
                The verdict again, here. The full result renders further up the
                page, which is above the fold by the time someone has scrolled
                down to choose a file — so without this, comparing a file looks
                like it did nothing at all.
              */}
              {fileMatch !== "not-compared" && (
                <p
                  className={`mt-4 rounded border px-4 py-3 text-sm font-medium ${
                    fileMatch === "match"
                      ? "border-chain-dim bg-chain-glow text-chain"
                      : "border-alert/50 bg-alert/10 text-alert"
                  }`}
                >
                  {fileMatch === "match"
                    ? "This file matches the mark. The full result is above."
                    : "This file does not match the mark — it is not the file this receipt records. The comparison is above."}
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
