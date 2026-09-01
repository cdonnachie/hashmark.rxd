/**
 * The HashMark mark.
 *
 * A checkmark built from six short strokes of unequal length — the "hash-like
 * lines" of the brief. The strokes are not decorative: the short rising ones
 * are the local half and the long falling one is the chain half, which is why
 * the two-tone variant colours them differently. It reads as a tick at 16px and
 * as a set of measured marks at 200px.
 */
export function Mark({
  size = 24,
  className,
  duotone = false,
}: {
  size?: number;
  className?: string;
  duotone?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Rising strokes — the short marks, stepping up to the turn. */}
      <path
        d="M4 17.5 L7 20.5"
        stroke={duotone ? "var(--color-local)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      <path
        d="M8.5 22 L11.5 25"
        stroke={duotone ? "var(--color-local)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      {/* The turn. */}
      <path
        d="M13 26.5 L15 28.5"
        stroke={duotone ? "var(--color-local)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      {/* Falling strokes — the long ascent, lengthening as it goes. */}
      <path
        d="M16.5 26 L20 20"
        stroke={duotone ? "var(--color-chain)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      <path
        d="M21.5 17 L25 10"
        stroke={duotone ? "var(--color-chain)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      <path
        d="M26.5 7 L29 3"
        stroke={duotone ? "var(--color-chain)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <Mark size={20} duotone />
      <span
        className="font-display text-[0.9375rem] font-semibold tracking-tight text-text"
        style={{ fontStretch: "semi-condensed" }}
      >
        HashMark
      </span>
    </span>
  );
}
