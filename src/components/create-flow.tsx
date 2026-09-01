"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  canonicalAttestationMessage,
  bytesToHex,
  MAX_LABEL_BYTES,
  RADIANT_MAINNET,
  SHA256,
  buildReceipt,
  encodeHashMarkScript,
  labelByteLength,
  serializeReceipt,
} from "@hashmark/protocol";

import { ByteGrid } from "@/components/byte-grid";
import { DropZone, type HashedFile } from "@/components/drop-zone";
import { MarkResult } from "@/components/mark-result";
import { explorerTxUrl, formatRxd, NETWORK } from "@/lib/config";
import { formatBytes } from "@/lib/hashing/digest";
import {
  decodeRadiantAddress,
  electrumScriptHash,
  shortenAddress,
} from "@/lib/radiant/address";
import { browserChain, browserElectrum } from "@/lib/radiant/client";
import { InsufficientFundsError, buildHashMarkTx, type BuildResult } from "@/lib/radiant/tx";
import { waveNamesForAddress } from "@/lib/radiant/wave";
import { photonicWallet } from "@/lib/wallet/photonic";
import { WalletError } from "@/lib/wallet/types";
import {
  clearAttestation,
  clearDraft,
  clearIdentity,
  loadAttestation,
  loadDraft,
  loadIdentity,
  saveDraft,
  setIdentityWaveNames,
  type StoredAttestation,
} from "@/lib/wallet/session";
import type { WalletIdentity } from "@/lib/wallet/types";
import { useTrackedTransaction } from "@/lib/use-tracked-transaction";

/**
 * Creating a mark.
 *
 * The flow is deliberately linear and slow at one point: the review step. After
 * broadcast nothing can be edited, deleted or taken back, so the user sees
 * exactly what will become public *before* the wallet is ever opened.
 *
 * Because Photonic navigates the whole tab away, this component is resumable:
 * the draft is written to sessionStorage before leaving, and a result arrives
 * back as query parameters from /wallet/callback.
 */

/** The result screen is not a stage: it is derived from the URL (see below). */
type Stage = "choose" | "review" | "broadcasting";

export function CreateFlow() {
  const router = useRouter();
  const params = useSearchParams();

  const [file, setFile] = useState<HashedFile | null>(null);
  const [label, setLabel] = useState("");
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [build, setBuild] = useState<BuildResult | null>(null);
  /**
   * The wallet's signature over this mark's statement, from the trip before
   * this one. Held until it is written into a transaction, and discarded the
   * moment the file or label it covers changes.
   */
  const [attestation, setAttestation] = useState<StoredAttestation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
   * What the wallet handed back is derived from the URL, not copied into state.
   *
   * /wallet/callback returns here with a full page load, so this component
   * mounts fresh and the query string is the whole story. Deriving it avoids an
   * effect that would only exist to duplicate what is already in `params`, and
   * there is nothing to replay on refresh — these values are display only.
   */
  const txid = params.get("txid");
  const walletStatus = params.get("wallet");
  const detail = params.get("detail");

  const callbackError =
    walletStatus === "rejected"
      ? detail
        ? `The wallet declined the request: ${detail}`
        : "The request was declined in your wallet. Nothing was published."
      : walletStatus === "error"
        ? (detail ?? "The wallet could not complete the request.")
        : null;

  const notice =
    walletStatus === "connected" && txid === null
      ? "Wallet connected."
      : walletStatus === "attested" && txid === null
        ? "Mark signed. Nothing is published yet."
        : null;

  /*
   * Restore what the trip to the wallet interrupted.
   *
   * eslint-disable-next-line is deliberate and narrow. sessionStorage cannot be
   * read during render: the server has no access to it, so doing so would make
   * the first client render disagree with the server's and break hydration.
   * Reading it once after mount is the correct pattern, and the cascading
   * render the rule warns about is exactly one, on mount only.
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- see the note above */
    setIdentity(loadIdentity());
    setAttestation(loadAttestation());
    const draft = loadDraft();
    if (draft) {
      setLabel(draft.label ?? "");
      setFile({
        digest: draft.digest,
        name: draft.fileName ?? "your file",
        size: draft.fileSize ?? 0,
        type: "",
      });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  /*
   * Track the broadcast transaction until it settles.
   *
   * The wallet saying it broadcast is not the same as the network having
   * accepted it, so the result is always read back from a node. It keeps
   * re-reading until the mark is confirmed, because this is the screen where
   * someone waits to see their transaction land.
   */
  const tracked = useTrackedTransaction(txid);
  const mark =
    tracked.state.kind === "loaded" ? (tracked.state.verification.marks[0] ?? null) : null;

  /*
   * Resolve a WAVE name for the connected address.
   *
   * Cosmetic only — it is never used to authorize anything, so a failure just
   * leaves the shortened address in place. Done here rather than in the wallet
   * callback so the redirect back is not held up by a name lookup.
   */
  useEffect(() => {
    const address = identity?.address;
    if (address === undefined || identity?.waveNames !== undefined) return;
    let cancelled = false;

    waveNamesForAddress(browserElectrum(), address)
      .then((names) => {
        if (cancelled || names.length === 0) return;
        setIdentityWaveNames(names);
        setIdentity((current) =>
          current && current.address === address
            ? { ...current, waveNames: names }
            : current,
        );
      })
      .catch(() => {
        // A name-service outage must never block marking a file.
      });

    return () => {
      cancelled = true;
    };
  }, [identity?.address, identity?.waveNames]);

  const labelBytes = labelByteLength(label);
  const labelTooLong = labelBytes > MAX_LABEL_BYTES;

  const trimmedLabel = label.trim() === "" ? undefined : label.trim();

  /**
   * Whether the signature in hand actually covers what is on screen.
   *
   * A signature is over one exact statement — this digest, this label, this
   * signer. Change any of them and it is a signature for something else, so it
   * has to be thrown away rather than reused.
   */
  const attestationMatches =
    attestation !== null &&
    file !== null &&
    identity !== null &&
    attestation.digest === file.digest &&
    attestation.label === trimmedLabel &&
    attestation.address === identity.address;

  /**
   * Ask the wallet to sign this mark's statement.
   *
   * A separate trip from connecting, and from broadcasting. The wallet renders
   * the statement verbatim, so this is the screen where the user actually sees
   * the digest and label they are attesting to.
   */
  const signStatement = useCallback(() => {
    if (!file || !identity || submitting) return;
    setLocalError(null);

    const hash160 = decodeRadiantAddress(identity.address);
    if (!hash160) {
      setLocalError("The connected address is not valid.");
      return;
    }

    // Everything needed to resume, written down before the tab goes away.
    saveDraft({
      digest: file.digest,
      label: trimmedLabel,
      fileName: file.name,
      fileSize: file.size,
    });

    try {
      const message = canonicalAttestationMessage({
        genesisHash: NETWORK.genesisHash,
        signerHash160: bytesToHex(hash160),
        algorithmId: SHA256.id,
        digest: file.digest,
        label: trimmedLabel,
      });
      photonicWallet.signStatement({
        message,
        digest: file.digest,
        label: trimmedLabel,
      });
    } catch (cause) {
      if (cause instanceof WalletError) return; // navigating away
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "Could not prepare the statement to sign.",
      );
    }
  }, [file, identity, submitting, trimmedLabel]);

  const prepare = useCallback(async () => {
    if (!file || !identity) return;
    if (attestation === null || !attestationMatches) return;
    setLocalError(null);
    setSubmitting(true);

    try {
      const dataScript = encodeHashMarkScript({
        algorithm: "sha256",
        digest: file.digest,
        label: trimmedLabel,
        signerHash160: attestation.signerHash160,
        signature: attestation.signature,
      });

      const scriptHash = electrumScriptHash(identity.address);
      if (!scriptHash) throw new Error("Connected address is not valid.");

      const utxos = await browserChain().listUnspent(scriptHash);
      setBuild(
        buildHashMarkTx({
          utxos,
          dataScript,
          changeAddress: identity.address,
        }),
      );
      setStage("review");
    } catch (cause) {
      if (cause instanceof InsufficientFundsError) {
        setLocalError(
          `${cause.message} Add a little RXD to this wallet and try again.`,
        );
      } else {
        setLocalError(
          cause instanceof Error
            ? cause.message
            : "Could not prepare the transaction.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [file, identity, attestation, attestationMatches, trimmedLabel]);

  /*
   * Coming back from the signing trip, go straight on to working out the fee.
   *
   * The user asked for one thing — "sign this mark" — and a second button to
   * press on return would be a step they did not ask for.
   */
  useEffect(() => {
    if (walletStatus !== "attested" || txid !== null) return;
    if (!attestationMatches || build !== null || submitting) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect --
       The external system being synchronized with is the wallet round trip:
       its result arrives as a query parameter plus a sessionStorage entry, and
       neither can be read during render. Resuming on arrival is the whole
       point of the effect, and it runs once per return. */
    void prepare();
  }, [walletStatus, txid, attestationMatches, build, submitting, prepare]);

  /**
   * Throw away a signature and anything built from it.
   *
   * A signature covers one exact statement, so changing the file, the label or
   * the wallet invalidates it. Called from the handlers that make those
   * changes rather than from an effect watching for them: the change is the
   * event, and reacting to it after the fact would mean a render where the
   * screen and the signature disagree.
   */
  const discardAttestation = useCallback(() => {
    clearAttestation();
    setAttestation(null);
    setBuild(null);
    setStage("choose");
  }, []);

  const approve = useCallback(() => {
    if (!file || !build || submitting) return;
    // Guard against a double click sending two transactions.
    setSubmitting(true);
    setStage("broadcasting");

    saveDraft({
      digest: file.digest,
      label: label.trim() === "" ? undefined : label.trim(),
      fileName: file.name,
      fileSize: file.size,
    });

    try {
      photonicWallet.signAndBroadcast(build.tx, {
        digest: file.digest,
        label: label.trim() === "" ? undefined : label.trim(),
        // The HashMark record is always output 0 of a transaction we built.
        outputIndex: 0,
      });
    } catch {
      // signAndBroadcast navigates away and never returns normally.
    }
  }, [file, build, label, submitting]);

  function downloadReceipt(): void {
    if (!file || !txid) return;
    const receipt = buildReceipt({
      network: RADIANT_MAINNET,
      algorithm: "sha256",
      digest: file.digest,
      transactionId: txid,
      // The HashMark record is always output 0 of a transaction we built.
      outputIndex: mark?.outputIndex ?? 0,
      label: label.trim() === "" ? undefined : label.trim(),
      // What a reader should expect. The chain still decides whether it holds.
      expectedSigner: mark?.signer ?? identity?.address,
    });
    const blob = new Blob([serializeReceipt(receipt)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    // Fixed, sanitized filename. A user-supplied name is never used as a path.
    anchor.download = `hashmark-${txid.slice(0, 12)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // ── Done ────────────────────────────────────────────────────────────────
  if (txid !== null) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-chain-dim bg-chain-glow p-5 sm:p-6">
          <p className="font-display text-sm font-semibold text-chain">
            Broadcast to Radiant
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Your wallet published the transaction and the network accepted it.
            It is not settled until it is in a block.{" "}
            {tracked.settled
              ? "It is now confirmed."
              : "This page rechecks on its own until it is, so you can leave it open."}
          </p>
          <p className="digest mt-4 text-sm break-all text-text">{txid}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={downloadReceipt}
              className="rounded bg-chain px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
            >
              Download receipt
            </button>
            <Link
              href={`/tx/${txid}`}
              className="rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
            >
              Open this mark
            </Link>
            <a
              href={explorerTxUrl(txid)}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
            >
              View in explorer
            </a>
          </div>
        </div>

        {mark ? (
          <MarkResult mark={mark} localDigest={file?.digest} match="match" />
        ) : (
          <p className="text-sm text-muted">
            Reading the transaction back from a Radiant node…
          </p>
        )}

        <button
          type="button"
          onClick={() => {
            clearDraft();
            setFile(null);
            setLabel("");
            setBuild(null);
            setStage("choose");
            // The result lives in the URL, so clearing it is the reset.
            router.replace("/create");
          }}
          className="text-sm text-muted underline underline-offset-4 hover:text-text"
        >
          Mark another file
        </button>
      </div>
    );
  }

  // ── Broadcasting ────────────────────────────────────────────────────────
  if (stage === "broadcasting") {
    return (
      <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
        <p className="font-display text-sm font-semibold text-text">
          Waiting for your wallet
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Approve the transaction in Photonic. Nothing is published until you do,
          and you can still decline.
        </p>
      </div>
    );
  }

  // ── Choose and review ───────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {notice && (
        <p className="rounded border border-chain-dim bg-chain-glow px-4 py-2.5 text-sm text-chain">
          {notice}
        </p>
      )}
      {(localError ?? callbackError) && (
        <div
          role="alert"
          className="rounded-lg border border-alert/50 bg-alert/10 p-5"
        >
          <p className="text-sm leading-relaxed text-muted">
            {localError ?? callbackError}
          </p>
        </div>
      )}

      {/* 1 — the file */}
      <section>
        <h2 className="font-display text-sm font-semibold text-text">
          The file
        </h2>
        <p className="mt-1.5 mb-4 text-sm text-muted">
          Hashed here in your browser. It is never uploaded.
        </p>

        {file ? (
          <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-text">{file.name}</p>
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setBuild(null);
                  setStage("choose");
                  clearDraft();
                }}
                className="text-xs text-muted underline underline-offset-4 hover:text-text"
              >
                Choose a different file
              </button>
            </div>
            <ByteGrid
              digest={file.digest}
              tone="local"
              label="The fingerprint of the file you chose"
            />
            {file.size > 0 && (
              <p className="mt-3 text-xs text-muted">{formatBytes(file.size)}</p>
            )}
          </div>
        ) : (
          <DropZone
            onHashed={(hashed) => {
              setFile(hashed);
              discardAttestation();
            }}
            idle="Drop the file you want to mark"
            hint="Hashed on your device — never uploaded"
          />
        )}
      </section>

      {/* 2 — the label */}
      {file && (
        <section>
          <label
            htmlFor="label"
            className="font-display text-sm font-semibold text-text"
          >
            Public label
            <span className="ml-2 font-body text-xs font-normal text-faint">
              optional
            </span>
          </label>
          <p className="mt-1.5 mb-3 text-sm text-muted">
            A short note recorded alongside the fingerprint, to help you
            recognise this mark later.
          </p>

          <input
            id="label"
            type="text"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
              discardAttestation();
            }}
            placeholder="Contract draft"
            aria-describedby="label-warning label-count"
            className="w-full rounded border border-line bg-ink px-3 py-2.5 text-sm text-text placeholder:text-faint"
          />

          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
            <p
              id="label-count"
              className={`text-xs ${labelTooLong ? "text-alert" : "text-faint"}`}
            >
              {labelBytes} of {MAX_LABEL_BYTES} bytes
              {labelBytes !== label.length && " (some characters take more than one byte)"}
            </p>
          </div>

          <p
            id="label-warning"
            className="mt-3 rounded border border-caution/40 bg-caution/5 px-4 py-3 text-sm leading-relaxed text-caution"
          >
            Anything you type here becomes permanently public on the Radiant
            blockchain. It cannot be edited or deleted afterwards. Do not put a
            filename, a person&rsquo;s name, or anything private in it.
          </p>
        </section>
      )}

      {/* 3 — the wallet */}
      {file && (
        <section>
          <h2 className="font-display text-sm font-semibold text-text">
            Your wallet
          </h2>
          <p className="mt-1.5 mb-4 text-sm text-muted">
            Recording a mark costs a small Radiant network fee, so it needs a
            wallet. HashMark never sees your keys or your seed phrase.
          </p>

          {identity ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-5 py-4">
              <div>
                <p className="eyebrow mb-1">Connected</p>
                {/*
                  The address leads, never the WAVE name. The address is what
                  the wallet proved control of with a signature we verified,
                  and it is what Photonic shows on its own approval screen — so
                  it is the one thing a user can check on both sides. A name is
                  a mutable index lookup: re-pointable by whoever controls it,
                  and unverifiable from here.
                */}
                <p className="digest text-sm text-text" title={identity.address}>
                  {shortenAddress(identity.address)}
                </p>
                {identity.waveNames !== undefined &&
                  identity.waveNames.length > 0 && (
                    <p
                      className="mt-1 text-xs text-muted"
                      title={`WAVE names held by this address: ${identity.waveNames.join(
                        ", ",
                      )}. The address above is what your wallet actually proved control of.`}
                    >
                      {identity.waveNames[0]}
                      {identity.waveNames.length > 1 && (
                        <span className="text-faint">
                          {" "}
                          and {identity.waveNames.length - 1} other{" "}
                          {identity.waveNames.length === 2 ? "name" : "names"}
                        </span>
                      )}
                    </p>
                  )}
              </div>
              <button
                type="button"
                onClick={() => {
                  clearIdentity();
                  setIdentity(null);
                  discardAttestation();
                }}
                className="text-xs text-muted underline underline-offset-4 hover:text-text"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                saveDraft({
                  digest: file.digest,
                  label: label.trim() === "" ? undefined : label.trim(),
                  fileName: file.name,
                  fileSize: file.size,
                });
                try {
                  photonicWallet.connect();
                } catch {
                  // connect() navigates away and never returns normally.
                }
              }}
              className="rounded bg-chain px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
            >
              Connect Photonic Wallet
            </button>
          )}
        </section>
      )}

      {/* 4 — review */}
      {file && identity && (
        <section>
          <h2 className="font-display text-sm font-semibold text-text">
            What will be published
          </h2>
          <p className="mt-1.5 mb-4 text-sm text-muted">
            This is everything the transaction records. Nothing else about the
            file leaves your device.
          </p>

          <dl className="overflow-hidden rounded-lg border border-line">
            <Row term="Fingerprint" mono>
              {file.digest}
            </Row>
            <Row term="Algorithm">SHA-256</Row>
            <Row term="Public label">
              {label.trim() === "" ? (
                <span className="text-faint">none</span>
              ) : (
                label.trim()
              )}
            </Row>
            <Row term="Network">{NETWORK.label}</Row>
            <Row term="Not recorded">
              <span className="text-muted">
                the file, its name, its size, its type, your IP address
              </span>
            </Row>
          </dl>

          {build ? (
            <>
              <dl className="mt-4 overflow-hidden rounded-lg border border-line">
                <Row term="Network fee">{formatRxd(build.fee)}</Row>
                <Row term="Returned as change">{formatRxd(build.change)}</Row>
                <Row term="Transaction size">
                  about {build.estimatedSize} bytes
                </Row>
                <Row term="Inputs spent">{build.tx.inputs.length}</Row>
              </dl>

              <button
                type="button"
                onClick={approve}
                disabled={submitting || labelTooLong}
                className="mt-5 rounded bg-chain px-5 py-2.5 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Approve in Photonic
              </button>
              <p className="mt-3 text-xs leading-relaxed text-faint">
                This opens your wallet. Nothing is published until you approve it
                there, and the wallet shows you the transaction again before you
                do.
              </p>
            </>
          ) : attestationMatches ? (
            <button
              type="button"
              onClick={() => void prepare()}
              disabled={submitting || labelTooLong}
              className="mt-5 rounded border border-line-bright px-5 py-2.5 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Checking your balance…" : "Work out the fee"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={signStatement}
                disabled={submitting || labelTooLong}
                className="mt-5 rounded border border-line-bright px-5 py-2.5 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain disabled:cursor-not-allowed disabled:opacity-40"
              >
                Sign this mark in your wallet
              </button>
              <p className="mt-3 text-xs leading-relaxed text-faint">
                Your wallet will show the exact statement — this fingerprint,
                this label — and ask you to sign it. Signing publishes nothing:
                the fee and the transaction come after. Photonic will flag the
                request as &ldquo;unrecognized&rdquo;, which is accurate. It is
                a signed statement, not a connection request.
              </p>
              <p className="mt-3 text-xs leading-relaxed text-caution">
                The signature permanently and publicly links this mark to your
                signing address, and to every other mark signed by the same key.
                For a business or a publisher that is the point. If you would
                rather your marks were not tied to your main address, connect a
                wallet kept only for HashMark.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Row({
  term,
  children,
  mono = false,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line bg-surface px-5 py-3.5 last:border-b-0 sm:flex-row sm:gap-6">
      <dt className="eyebrow sm:w-44 sm:shrink-0 sm:pt-0.5">{term}</dt>
      <dd
        className={`text-sm break-all text-text ${mono ? "digest text-xs" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}
