"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The fingerprint grid — HashMark's signature element.
 *
 * A SHA-256 digest is 32 bytes, so it is drawn as 32 cells: the actual data,
 * not an abstraction of it. The same component does three jobs, which is why it
 * earns its complexity:
 *
 *   1. **Progress.** While hashing, cells resolve left to right in step with
 *      real bytes processed. The scramble is bounded by actual progress, so it
 *      can never suggest work that is not happening.
 *   2. **Identity.** A finished digest is far easier to recognise and compare
 *      as a shaped grid than as a 64-character run of text.
 *   3. **Comparison.** Given `compareTo`, mismatched bytes are marked, so "this
 *      file is not that file" is visible rather than asserted.
 *
 * Colour follows the app's rule: violet while the digest is local, cyan once it
 * is on-chain.
 */

const BYTES = 32;
const HEX = "0123456789abcdef";

export type GridTone = "local" | "chain" | "muted";

const TONE_CLASS: Record<GridTone, string> = {
  local: "text-local border-local-dim/40",
  chain: "text-chain border-chain-dim/40",
  muted: "text-faint border-line",
};

function randomPair(): string {
  return (
    HEX[Math.floor(Math.random() * 16)]! + HEX[Math.floor(Math.random() * 16)]!
  );
}

export function ByteGrid({
  digest,
  progress = 1,
  tone = "local",
  compareTo,
  label,
}: {
  /** Lowercase hex digest, or undefined before hashing starts. */
  digest?: string | undefined;
  /** 0..1. Below 1, cells past the frontier scramble. */
  progress?: number;
  tone?: GridTone;
  /** A second digest to compare against, byte by byte. */
  compareTo?: string | undefined;
  /** Accessible description of what this grid shows. */
  label: string;
}) {
  const settled = digest !== undefined && progress >= 1;
  const [scramble, setScramble] = useState<string[]>(() =>
    Array.from({ length: BYTES }, randomPair),
  );
  const frameRef = useRef<number | undefined>(undefined);

  // Animate only while genuinely hashing. A settled or empty grid does no work.
  useEffect(() => {
    if (settled || digest === undefined) return;
    let last = 0;
    const tick = (time: number) => {
      if (time - last > 70) {
        last = time;
        setScramble(Array.from({ length: BYTES }, randomPair));
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [settled, digest]);

  const revealed = digest === undefined ? 0 : Math.floor(progress * BYTES);

  const cells = Array.from({ length: BYTES }, (_, i) => {
    if (digest === undefined) return { text: "", state: "empty" as const };
    const actual = digest.slice(i * 2, i * 2 + 2);
    if (i < revealed || settled) {
      const other = compareTo?.slice(i * 2, i * 2 + 2);
      const mismatch = other !== undefined && other !== actual;
      return { text: actual, state: mismatch ? ("mismatch" as const) : ("set" as const) };
    }
    return { text: scramble[i] ?? "", state: "pending" as const };
  });

  return (
    <div>
      <div
        className="grid grid-cols-8 gap-1 sm:gap-1.5"
        role="img"
        aria-label={
          digest === undefined
            ? label
            : `${label}: ${digest.slice(0, 8)} and 56 more characters`
        }
      >
        {cells.map((cell, i) => (
          <div
            key={i}
            className={[
              "flex aspect-square items-center justify-center rounded-sm border text-[0.5rem] tabular-nums transition-colors sm:text-[0.6875rem]",
              "digest",
              cell.state === "empty" && "border-line",
              cell.state === "pending" && "border-line text-muted",
              cell.state === "set" && TONE_CLASS[tone],
              cell.state === "mismatch" &&
                "border-alert bg-alert/10 text-alert font-bold",
              cell.state === "set" && "cell-settled",
            ]
              .filter(Boolean)
              .join(" ")}
            style={
              cell.state === "set"
                ? { animationDelay: `${Math.min(i * 12, 300)}ms` }
                : undefined
            }
          >
            {cell.text}
          </div>
        ))}
      </div>

      {/* The full digest stays available as selectable text: a grid is good for
          recognition, but people need to copy the real value. */}
      {settled && digest !== undefined && (
        <p className="digest mt-3 text-[0.6875rem] leading-relaxed text-muted">
          {digest}
        </p>
      )}
    </div>
  );
}
