"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { HashCancelledError, formatBytes, hashBlob } from "@/lib/hashing/digest";

/**
 * Local file hashing, with a drop target.
 *
 * The whole privacy claim lives here, so the mechanics matter: the `File` is
 * read through a stream, hashed in chunks, and never held in full, never
 * copied, and never sent anywhere. There is no upload endpoint in this
 * application for it to be sent to.
 *
 * The file handle is released as soon as hashing finishes — only the digest,
 * name, size and type survive, and only in memory.
 */

export interface HashedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly digest: string;
}

export function DropZone({
  onHashed,
  onCleared,
  idle = "Drop a file here",
  hint = "or choose one from your device",
  compact = false,
}: {
  onHashed: (file: HashedFile) => void;
  onCleared?: () => void;
  idle?: string;
  hint?: string;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState<{ name: string; size: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cancel any in-flight hash if the component goes away mid-file.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (file: File) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setBusy(true);
      setProgress(0);
      setCurrent({ name: file.name, size: file.size });

      try {
        const result = await hashBlob(file, {
          signal: controller.signal,
          onProgress: (p) => setProgress(p.fraction),
        });
        onHashed({
          name: file.name,
          size: file.size,
          type: file.type || "unknown",
          digest: result.digest,
        });
      } catch (cause) {
        if (cause instanceof HashCancelledError) {
          setCurrent(null);
          onCleared?.();
        } else {
          setError(
            cause instanceof Error
              ? `Could not read that file: ${cause.message}`
              : "Could not read that file.",
          );
          setCurrent(null);
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [onHashed, onCleared],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files.item(0);
      if (file) void run(file);
    },
    [run],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={[
          "relative overflow-hidden rounded-lg border border-dashed transition-colors",
          compact ? "p-5" : "p-8 sm:p-10",
          dragging
            ? "border-local bg-local-glow"
            : "border-line-bright bg-surface/60 hover:border-local-dim",
        ].join(" ")}
      >
        {busy && <div className="sweep pointer-events-none absolute inset-0" />}

        <div className="relative flex flex-col items-center gap-3 text-center">
          {busy ? (
            <>
              <p className="eyebrow">Hashing on your device</p>
              <p className="text-sm text-text">
                {current?.name ?? "Reading file"}
              </p>
              <div
                className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-line"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Hashing progress"
              >
                <div
                  className="h-full bg-local transition-[width] duration-150"
                  style={{ width: `${Math.max(progress * 100, 2)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={cancel}
                className="mt-1 text-xs text-muted underline underline-offset-4 hover:text-text"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-text">
                {idle}
              </p>
              <p className="text-xs text-muted">{hint}</p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-1 rounded border border-line-bright bg-raised px-3.5 py-1.5 text-xs font-medium text-text transition-colors hover:border-local-dim hover:text-local"
              >
                Choose file
              </button>
            </>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          // Visually hidden but still a real, focusable control, so it needs a
          // name of its own — the surrounding text is not associated with it.
          aria-label={idle}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.item(0);
            if (file) void run(file);
            // Clear so choosing the same file twice still fires a change event.
            event.target.value = "";
          }}
        />
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-alert">
          {error}
        </p>
      )}

      {current && !busy && (
        <p className="mt-2 text-xs text-muted">
          <span className="text-text">{current.name}</span> ·{" "}
          {formatBytes(current.size)}
        </p>
      )}
    </div>
  );
}
