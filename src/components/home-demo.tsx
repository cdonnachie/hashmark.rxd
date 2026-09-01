"use client";

import Link from "next/link";
import { useState } from "react";

import { ByteGrid } from "@/components/byte-grid";
import { DropZone, type HashedFile } from "@/components/drop-zone";
import { formatBytes } from "@/lib/hashing/digest";

/**
 * The hero is the product working.
 *
 * Rather than describing the privacy claim, the homepage demonstrates it: drop
 * a file, watch its fingerprint appear, and observe that no request was made.
 * Nothing here touches the network or a wallet — this is the honest half of the
 * product, free and offline, and it earns the trust the paid half needs.
 */
export function HomeDemo() {
  const [file, setFile] = useState<HashedFile | null>(null);

  return (
    <div className="rounded-lg border border-line bg-surface/70 p-5 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <p className="eyebrow">
          {file ? "Fingerprint" : "Try it now"}
        </p>
        {file && (
          <button
            type="button"
            onClick={() => setFile(null)}
            className="text-xs text-muted underline underline-offset-4 hover:text-text"
          >
            Clear
          </button>
        )}
      </div>

      {file ? (
        <div>
          <ByteGrid
            digest={file.digest}
            tone="local"
            label="SHA-256 fingerprint of the file you chose"
          />

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-5 text-sm sm:grid-cols-3">
            <div>
              <dt className="eyebrow mb-1">File</dt>
              <dd className="truncate text-text" title={file.name}>
                {file.name}
              </dd>
            </div>
            <div>
              <dt className="eyebrow mb-1">Size</dt>
              <dd className="text-text">{formatBytes(file.size)}</dd>
            </div>
            <div>
              <dt className="eyebrow mb-1">Type</dt>
              <dd className="truncate text-text">{file.type}</dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/create"
              className="rounded bg-chain px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90"
            >
              Record this on Radiant
            </Link>
            <Link
              href="/verify"
              className="rounded border border-line-bright px-4 py-2 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
            >
              Check for a mark
            </Link>
          </div>

          <p className="mt-4 text-xs text-muted">
            That fingerprint was calculated here, in this tab. The file itself
            was never read by anyone but your browser.
          </p>
        </div>
      ) : (
        <>
          <DropZone
            onHashed={setFile}
            idle="Drop a file to see its fingerprint"
            hint="Nothing is uploaded — hashing happens in this tab"
          />
          <div className="mt-6">
            <ByteGrid label="An empty fingerprint grid, waiting for a file" />
            <p className="mt-3 text-xs leading-relaxed text-faint">
              Thirty-two bytes. Every file has exactly one, and no two different
              files share it.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
