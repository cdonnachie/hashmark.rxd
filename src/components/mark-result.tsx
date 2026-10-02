"use client";

import { useState } from "react";

import { ByteGrid } from "@/components/byte-grid";
import { explorerTxUrl } from "@/lib/config";
import type { VerifiedMark } from "@/lib/verify";
import { formatBlockTime } from "@/lib/verify";
import type { MatchOutcome } from "@/lib/verify";

/**
 * The result panel every verification route shares.
 *
 * Three rules it exists to keep consistent:
 *
 *  1. **Confirmation state is never implied.** An unconfirmed mark says so, in
 *     its own words, and shows a first-seen time rather than a block time.
 *  2. **The label is escaped.** It is attacker-controlled public text; React's
 *     default escaping does the work, and it is never rendered as markup.
 *  3. **The blockchain detail lives behind a disclosure**, so an ordinary user
 *     is not asked to read a script to understand the answer.
 */

const STATE_COPY: Record<
  VerifiedMark["state"],
  { label: string; tone: string; detail: string }
> = {
  confirmed: {
    label: "Confirmed",
    tone: "text-chain border-chain-dim bg-chain-glow",
    detail:
      "Recorded in a block and buried under enough further blocks to be settled.",
  },
  confirming: {
    label: "Confirming",
    tone: "text-caution border-caution/50 bg-caution/10",
    detail:
      "In a block, but only just. Wait for more confirmations before relying on it — a very recent block can still be replaced.",
  },
  unconfirmed: {
    label: "Not yet confirmed",
    tone: "text-caution border-caution/50 bg-caution/10",
    detail:
      "Broadcast but not yet in a block. This is not proof of a time yet: an unconfirmed transaction can still be dropped or replaced.",
  },
};

const MATCH_COPY: Record<
  MatchOutcome,
  { title: string; body: string; tone: string } | null
> = {
  match: {
    title: "This file matches the mark",
    body: "The fingerprint calculated from your file is identical to the one on the chain. The file has not changed since it was recorded.",
    tone: "border-chain-dim bg-chain-glow text-chain",
  },
  "different-file": {
    title: "This file does not match the mark",
    body: "The mark records a different file. That is expected if you have a later draft, a re-saved copy, or a different document — it does not mean anything is wrong with your file.",
    tone: "border-alert/50 bg-alert/10 text-alert",
  },
  "not-compared": null,
};

export function MarkResult({
  mark,
  localDigest,
  match = "not-compared",
}: {
  mark: VerifiedMark;
  localDigest?: string | undefined;
  match?: MatchOutcome;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const state = STATE_COPY[mark.state];
  const matchCopy = MATCH_COPY[match];

  return (
    <div className="rounded-lg border border-line bg-surface">
      {matchCopy && (
        <div className={`border-b px-5 py-4 sm:px-6 ${matchCopy.tone}`}>
          <p className="font-display text-sm font-semibold">{matchCopy.title}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            {matchCopy.body}
          </p>
        </div>
      )}

      <div className="px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded border px-2.5 py-1 text-xs font-medium ${state.tone}`}
          >
            {state.label}
          </span>
          {mark.inclusion?.kind === "proved" ? (
            <span className="text-xs text-muted">
              <span className="text-text">
                at least{" "}
                {mark.inclusion.provedMinConfirmations.toLocaleString()}{" "}
                confirmations, proved
              </span>
              {" · "}
              {mark.confirmations.toLocaleString()} reported by the node
            </span>
          ) : (
            <span className="text-xs text-muted">
              {mark.confirmations.toLocaleString()}{" "}
              {mark.confirmations === 1 ? "confirmation" : "confirmations"}
            </span>
          )}
        </div>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          {state.detail}
        </p>
        {mark.state !== "unconfirmed" && <BlockProof mark={mark} />}

        <dl className="mt-6 space-y-5">
          <div>
            <dt className="eyebrow mb-1.5">
              {mark.state === "unconfirmed"
                ? "First seen"
                : "Recorded no later than"}
            </dt>
            <dd className="text-sm text-text">
              {mark.blockTime !== undefined ? (
                <>
                  {formatBlockTime(mark.blockTime)}{" "}
                  <span className="text-faint">UTC</span>
                </>
              ) : (
                <span className="text-caution">
                  Not yet in a block — no authoritative time
                </span>
              )}
            </dd>
            {mark.blockTime !== undefined && (
              <p className="mt-1.5 text-xs leading-relaxed text-faint">
                Block times are set by miners and are accurate to roughly an
                hour. Read this as an upper bound: the file existed by then, and
                possibly long before.
              </p>
            )}
          </div>

          {mark.record.label !== undefined && (
            <div>
              <dt className="eyebrow mb-1.5">Public label</dt>
              {/* React escapes this. It is never dangerouslySetInnerHTML. */}
              <dd className="text-sm break-words text-text">
                {mark.record.label}
              </dd>
              <p className="mt-1.5 text-xs text-faint">
                Written by whoever created the mark. Anyone can write anything
                here.
              </p>
            </div>
          )}

          <div>
            <dt className="eyebrow mb-2">Fingerprint on the chain</dt>
            <dd>
              <ByteGrid
                digest={mark.record.digest}
                tone="chain"
                compareTo={match === "different-file" ? localDigest : undefined}
                label="The fingerprint recorded on Radiant"
              />
            </dd>
          </div>

          {match === "different-file" && localDigest !== undefined && (
            <div>
              <dt className="eyebrow mb-2">Fingerprint of your file</dt>
              <dd>
                <ByteGrid
                  digest={localDigest}
                  tone="local"
                  compareTo={mark.record.digest}
                  label="The fingerprint of the file you chose"
                />
              </dd>
              <p className="mt-2 text-xs text-faint">
                Differing bytes are highlighted. A single changed byte anywhere
                in a file changes most of the fingerprint.
              </p>
            </div>
          )}

          <div>
            <dt className="eyebrow mb-1.5">Signed by</dt>
            <dd className="digest text-sm break-all text-text">
              {mark.signer ?? (
                <span className="text-muted">
                  no signature — this record predates signed attestations
                </span>
              )}
            </dd>
            {mark.signer !== undefined && (
              <p className="mt-2 text-xs leading-relaxed text-faint">
                The key that signed this statement. It does not say that this
                key published <em>this</em> transaction: a signed record can be
                copied byte for byte into anyone else&rsquo;s. It does not say who
                wrote the file. And it is only meaningful to you if you already
                recognise this address.
              </p>
            )}
          </div>

          <div>
            <dt className="eyebrow mb-1.5">Transaction</dt>
            <dd className="digest text-sm break-all text-text">{mark.txid}</dd>
            <a
              href={explorerTxUrl(mark.txid)}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-block text-xs text-chain underline underline-offset-4 hover:opacity-80"
            >
              Open in a Radiant explorer
            </a>
          </div>
        </dl>

        <div className="mt-6 border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setShowRaw((open) => !open)}
            aria-expanded={showRaw}
            className="text-xs text-muted underline underline-offset-4 hover:text-text"
          >
            {showRaw ? "Hide" : "Show"} technical details
          </button>

          {showRaw && (
            <dl className="mt-4 grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="eyebrow mb-1">Protocol version</dt>
                <dd className="digest text-text">{mark.record.version}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-1">Hash algorithm</dt>
                <dd className="digest text-text">
                  {mark.record.algorithm} (id {mark.record.algorithmId})
                </dd>
              </div>
              <div>
                <dt className="eyebrow mb-1">Output index</dt>
                <dd className="digest text-text">{mark.outputIndex}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-1">Confirmations</dt>
                <dd className="digest text-text">{mark.confirmations}</dd>
              </div>
              {mark.blockHash && (
                <div className="sm:col-span-2">
                  <dt className="eyebrow mb-1">Block hash</dt>
                  <dd className="digest break-all text-text">
                    {mark.blockHash}
                  </dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="eyebrow mb-1">Digest</dt>
                <dd className="digest break-all text-text">
                  {mark.record.digest}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What is known about the block, and how.
 *
 * Three honest sentences for three situations. The proved case says what was
 * proved and what was not (depth); the fallback names its reason so it never
 * reads as a fault in the mark; the contradicted case is the only one in
 * alarm colours, because only there did something actually go wrong.
 */
function BlockProof({ mark }: { mark: VerifiedMark }) {
  const inclusion = mark.inclusion;

  if (inclusion?.kind === "proved") {
    return (
      <p className="mt-2 text-xs leading-relaxed text-faint">
        <span className="text-chain">Block proved.</span> This page checked
        that the transaction is in block{" "}
        {inclusion.height.toLocaleString()}, and that the block belongs to the
        chain anchored by the checkpoint this build ships at height{" "}
        {inclusion.checkpointHeight.toLocaleString()}, so the date above was
        read from a verified header. The same anchor proves at least{" "}
        {inclusion.provedMinConfirmations.toLocaleString()} confirmations,
        counting only blocks up to the checkpoint; the node&rsquo;s higher
        count includes newer blocks and remains its word.
      </p>
    );
  }

  if (inclusion?.kind === "contradicted") {
    return (
      <p
        role="alert"
        className="mt-2 text-xs leading-relaxed text-alert"
      >
        The connected node&rsquo;s own proofs do not support the block it
        reports for this transaction ({inclusion.detail}). Treat the date as
        unknown. The record and its signature are unaffected, but where and
        when it was confirmed cannot be trusted from this node.
      </p>
    );
  }

  const why =
    inclusion?.reason === "ABOVE_CHECKPOINT"
      ? "This mark is newer than the checkpoint this build ships, so its block cannot be proved yet; a later build will cover it."
      : "The connected node could not supply inclusion proofs.";
  return (
    <p className="mt-2 text-xs leading-relaxed text-faint">
      The block and confirmation count are the connected node&rsquo;s word.{" "}
      {why} This is not a problem with the mark: the record and its signature
      were read from the transaction and checked here either way.
    </p>
  );
}
