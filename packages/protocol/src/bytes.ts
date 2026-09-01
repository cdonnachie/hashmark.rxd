/**
 * Byte helpers shared by the encoder, decoder and receipt validator.
 *
 * Deliberately dependency-free and platform-neutral: this package is meant to
 * be liftable into a standalone npm module that a third-party verifier can use
 * in a browser, in Node, or in a worker, without pulling in a Radiant library.
 */

/** Lowercase hex is the only digest encoding this protocol produces or accepts. */
const HEX_RE = /^[0-9a-f]*$/;

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Strict hex decode: even length, lowercase only. Uppercase is rejected rather
 * than normalized so that a digest has exactly one accepted spelling — a
 * verifier comparing two records must never have to case-fold first.
 */
export function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  if (!HEX_RE.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Constant-length equality. Not constant-*time*: nothing here is secret. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const utf8Encoder = new TextEncoder();

export function utf8ToBytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/**
 * Strict UTF-8 decode. Returns undefined rather than U+FFFD on malformed
 * input: a label that does not round-trip is a malformed record, not a record
 * with odd characters in it.
 */
export function bytesToUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Why a label is unfit to carry.
 *
 * `CONTROL_CHARS` and `BIDI` are about what the text can do to a *display*: a
 * newline can fabricate a line in a message a wallet renders for approval, and
 * a bidirectional override can reverse the visual order of everything after it,
 * so a screen reads as one thing while the bytes say another. `NON_CANONICAL`
 * is about identity: a label that is not already trimmed and NFC-normalized is
 * not the label that was signed.
 */
export type LabelDefect = "CONTROL_CHARS" | "BIDI" | "NON_CANONICAL";

/**
 * Characters that can hide or reorder rendered text.
 *
 * U+200C ZWNJ and U+200D ZWJ are deliberately absent: they are joiners, not
 * directional controls, they cannot reorder anything, and they are load-bearing
 * in Devanagari and in emoji sequences.
 */
const BIDI_OR_INVISIBLE_RE =
  /[\u061C\u200B\u200E-\u200F\u2028-\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * The defect in `text`, or undefined when it is fit to use as a label.
 *
 * Checked in order, most concrete first, so the reported reason is the one a
 * person can act on.
 */
export function labelDefect(text: string): LabelDefect | undefined {
  if (hasControlChars(text)) return "CONTROL_CHARS";
  if (BIDI_OR_INVISIBLE_RE.test(text)) return "BIDI";
  if (text !== text.trim() || text !== text.normalize("NFC")) {
    return "NON_CANONICAL";
  }
  return undefined;
}

/**
 * True for C0 controls, DEL, and the C1 range.
 *
 * Public metadata must contain none of them: they let a label smuggle line
 * breaks or terminal escapes past a human reviewing it, and they have no
 * legitimate use in a short public caption. C1 is included because terminals
 * and some legacy renderers still act on it, and a label is displayed in places
 * this protocol does not control.
 *
 * Implemented with `charCodeAt` rather than a regex literal so this source file
 * carries no literal control bytes.
 */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
