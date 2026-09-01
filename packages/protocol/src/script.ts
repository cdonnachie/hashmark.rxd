/**
 * The minimum of Bitcoin-style script needed to read and write a HashMark
 * data output. Not a general script engine — it understands data pushes and
 * nothing else, which is all a `OP_RETURN` payload ever contains.
 *
 * Every push this module writes, and every push it accepts, is *minimally
 * encoded*: the shortest opcode able to carry that length. That is what gives
 * a HashMark record exactly one canonical serialization, so two encoders
 * independently producing the same record produce identical bytes, and a
 * verifier can compare records byte-for-byte.
 */

export const OP_0 = 0x00;
export const OP_PUSHDATA1 = 0x4c;
export const OP_PUSHDATA2 = 0x4d;
export const OP_PUSHDATA4 = 0x4e;
export const OP_RETURN = 0x6a;

/** Consensus cap on a single stack element (Radiant Core `MAX_SCRIPT_ELEMENT_SIZE`). */
export const MAX_PUSH_BYTES = 520;

/** The largest length a bare length-byte opcode (0x01..0x4b) can express. */
const MAX_DIRECT_PUSH = 0x4b;

/**
 * Encode one data push, minimally. Throws on inputs this protocol never
 * produces — an empty push (which would be `OP_0`, not a data push) or one
 * above the consensus element limit.
 */
export function encodePush(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    throw new RangeError("encodePush: refusing to encode an empty push");
  }
  if (data.length > MAX_PUSH_BYTES) {
    throw new RangeError(
      `encodePush: ${data.length} bytes exceeds MAX_PUSH_BYTES (${MAX_PUSH_BYTES})`,
    );
  }

  if (data.length <= MAX_DIRECT_PUSH) {
    const out = new Uint8Array(1 + data.length);
    out[0] = data.length;
    out.set(data, 1);
    return out;
  }

  if (data.length <= 0xff) {
    const out = new Uint8Array(2 + data.length);
    out[0] = OP_PUSHDATA1;
    out[1] = data.length;
    out.set(data, 2);
    return out;
  }

  const out = new Uint8Array(3 + data.length);
  out[0] = OP_PUSHDATA2;
  out[1] = data.length & 0xff;
  out[2] = (data.length >> 8) & 0xff;
  out.set(data, 3);
  return out;
}

/**
 * Bytes a minimally-encoded push of `length` occupies, prefix included.
 *
 * Used to compute how much of the relay budget a record spends before its
 * label, so the label cap is derived from the record's actual shape rather than
 * assumed from one algorithm's digest length. Throws on zero for the same
 * reason {@link encodePush} does: an absent field is no push at all, not an
 * empty one, so a caller must decide that before asking.
 */
export function encodedPushSize(length: number): number {
  if (length <= 0) {
    throw new RangeError("encodedPushSize: a push of zero bytes is not encoded");
  }
  if (length > MAX_PUSH_BYTES) {
    throw new RangeError(
      `encodedPushSize: ${length} bytes exceeds MAX_PUSH_BYTES (${MAX_PUSH_BYTES})`,
    );
  }
  if (length <= MAX_DIRECT_PUSH) return 1 + length;
  if (length <= 0xff) return 2 + length;
  return 3 + length;
}

/**
 * Read every data push in `script`, starting at `offset`.
 *
 * Returns undefined — never a partial list — if the script contains anything
 * that is not a minimally-encoded data push. That includes `OP_0`, the
 * small-integer opcodes `OP_1`..`OP_16`, `OP_1NEGATE`, any non-push opcode,
 * a truncated push, and a non-minimal `OP_PUSHDATA*` (for example
 * `OP_PUSHDATA1 0x20` for a 32-byte digest, which must use the direct form).
 *
 * Refusing the small-integer opcodes is what keeps decoding unambiguous: a
 * one-byte version field could otherwise be spelled either `0x01 0x01` or
 * `OP_1`, and two spellings of one record would break byte-wise comparison.
 */
export function readPushes(
  script: Uint8Array,
  offset = 0,
): Uint8Array[] | undefined {
  const pushes: Uint8Array[] = [];
  let i = offset;

  while (i < script.length) {
    const opcode = script[i];
    if (opcode === undefined) return undefined;
    i += 1;

    let length: number;

    if (opcode >= 0x01 && opcode <= MAX_DIRECT_PUSH) {
      length = opcode;
    } else if (opcode === OP_PUSHDATA1) {
      const n = script[i];
      if (n === undefined) return undefined;
      i += 1;
      // Non-minimal: this length fits a direct push.
      if (n <= MAX_DIRECT_PUSH) return undefined;
      length = n;
    } else if (opcode === OP_PUSHDATA2) {
      const lo = script[i];
      const hi = script[i + 1];
      if (lo === undefined || hi === undefined) return undefined;
      i += 2;
      const n = lo | (hi << 8);
      // Non-minimal: this length fits OP_PUSHDATA1.
      if (n <= 0xff) return undefined;
      length = n;
    } else {
      // OP_0, OP_1NEGATE, OP_1..OP_16, OP_PUSHDATA4 and every non-push opcode.
      return undefined;
    }

    if (length > MAX_PUSH_BYTES) return undefined;
    if (i + length > script.length) return undefined; // truncated

    pushes.push(script.subarray(i, i + length));
    i += length;
  }

  return pushes;
}
