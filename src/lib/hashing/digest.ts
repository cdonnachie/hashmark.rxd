/**
 * Streamed file hashing.
 *
 * ## Why not `crypto.subtle.digest`
 *
 * The brief calls for Web Crypto, and Web Crypto is the right primitive — but
 * it has no streaming interface. `crypto.subtle.digest` takes one contiguous
 * buffer and returns one promise, which makes three of our stated requirements
 * impossible at once:
 *
 *   - **No progress.** There is no callback between "started" and "finished".
 *   - **No cancellation.** The operation is not abortable.
 *   - **The whole file must be resident in memory.** A 2 GB video would need a
 *     2 GB `ArrayBuffer` before hashing could begin, which on most devices
 *     fails outright.
 *
 * So we stream with `@noble/hashes`, which exposes an incremental
 * `create()/update()/digest()` interface, and read the file through
 * `Blob.stream()` so only one chunk is resident at a time.
 *
 * Correctness is not taken on trust: `digest.test.ts` checks this
 * implementation against `crypto.subtle.digest` over the same inputs, plus the
 * published NIST/RFC test vectors. If the two ever disagree, the tests fail.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex } from "@hashmark/protocol";

/** Bytes read per chunk. Large enough to keep hashing throughput up, small
 *  enough that progress feels continuous and memory stays flat. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

export interface HashProgress {
  /** Bytes hashed so far. */
  readonly bytesProcessed: number;
  /** Total bytes, from the file's own size. */
  readonly bytesTotal: number;
  /** 0..1. Exactly 1 only once hashing is complete. */
  readonly fraction: number;
}

export interface HashOptions {
  readonly onProgress?: (progress: HashProgress) => void;
  readonly signal?: AbortSignal;
  /** Overridable for tests. */
  readonly chunkBytes?: number;
}

/** Thrown when hashing is cancelled through the `AbortSignal`. */
export class HashCancelledError extends Error {
  constructor() {
    super("Hashing was cancelled");
    this.name = "HashCancelledError";
  }
}

export interface HashResult {
  readonly algorithm: "sha256";
  /** Lowercase hex, always. */
  readonly digest: string;
  readonly bytesTotal: number;
}

/**
 * Hash a `Blob` (or `File`) with SHA-256, reporting progress and honouring
 * cancellation.
 *
 * The file's bytes are never retained: each chunk is fed to the hash and then
 * dropped, and nothing but the running 32-byte state survives between chunks.
 */
export async function hashBlob(
  blob: Blob,
  options: HashOptions = {},
): Promise<HashResult> {
  const { onProgress, signal } = options;
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;

  if (signal?.aborted) throw new HashCancelledError();

  const bytesTotal = blob.size;
  const hash = sha256.create();
  let bytesProcessed = 0;

  const report = () => {
    onProgress?.({
      bytesProcessed,
      bytesTotal,
      // An empty file is complete the moment it starts; avoid 0/0 = NaN.
      fraction: bytesTotal === 0 ? 1 : bytesProcessed / bytesTotal,
    });
  };

  report();

  // `Blob.stream()` is available in every browser we target (Chrome/Edge 111+,
  // Firefox 111+, Safari 16.4+ — the Next.js 16 baseline) and in Node 18+.
  // Slicing manually would work too, but the stream lets the platform manage
  // read-ahead and keeps exactly one chunk alive at a time.
  const reader = blob.stream().getReader();

  try {
    for (;;) {
      if (signal?.aborted) throw new HashCancelledError();

      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      // A stream chunk can exceed our progress granularity, so walk it in
      // slices. This keeps progress smooth regardless of the platform's
      // internal chunk size.
      for (let offset = 0; offset < value.length; offset += chunkBytes) {
        if (signal?.aborted) throw new HashCancelledError();
        const slice = value.subarray(offset, offset + chunkBytes);
        hash.update(slice);
        bytesProcessed += slice.length;
        report();
        // Yield to the event loop so a cancel click is handled promptly. In a
        // worker this keeps the message port responsive; on the main thread it
        // is what stops the interface freezing.
        await Promise.resolve();
      }
    }
  } finally {
    // Releasing the lock lets the underlying source be collected immediately,
    // including on the cancellation path.
    reader.releaseLock();
  }

  if (signal?.aborted) throw new HashCancelledError();

  return {
    algorithm: "sha256",
    digest: bytesToHex(hash.digest()),
    bytesTotal,
  };
}

/** Human-readable byte size, for showing a file's size locally. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
