/**
 * PSBT builder for Radiant.
 *
 * We only ever **serialize**. HashMark never signs, never finalizes and never
 * parses a wallet-supplied PSBT for value, which is what keeps a hand-written
 * implementation safe here.
 *
 * ## Which PSBT this is
 *
 * Radiant Core implements PSBT, but not stock BIP-174: it is the Bitcoin
 * ABC-lineage, **segwit-stripped** variant. Photonic's `@photonic/lib` targets
 * that same profile, and is not published to npm (verified 404), so this
 * mirrors its wire format, read from `packages/lib/src/psbt/{psbt,keyvalue}.ts`
 * in the Photonic repository.
 *
 * The one divergence that matters:
 *
 *   Mainline BIP-174 has `non_witness_utxo` (key 0x00, a **full previous
 *   transaction**) and `witness_utxo` (key 0x01, a bare `CTxOut`). Radiant has
 *   no segwit, so key 0x01 does not exist — and key **0x00 itself carries a
 *   bare `CTxOut`**: int64-LE value followed by a varint-length scriptPubKey.
 *
 * That is safe because Radiant's FORKID sighash commits to exactly that
 * output's script and value, so declaring a wrong one produces a signature that
 * fails to verify rather than one that misdirects funds.
 *
 * Container framing:
 *
 *   magic 70 73 62 74 ff
 *   global map:  key 0x00 = unsigned tx, then a 0x00 separator
 *   one map per input:  key 0x00 = CTxOut, then a 0x00 separator
 *   one map per output: just a 0x00 separator (we emit no output entries)
 *
 * Each entry is `varint keylen ‖ keytype(varint) ‖ keydata` then
 * `varint vallen ‖ value`. CompactSize varints must be minimally encoded —
 * Radiant Core's `ReadCompactSize` rejects non-canonical forms.
 */

import { concatBytes } from "@hashmark/protocol";

import { serializeUnsignedTx, writeInt64LE, type UnsignedTransaction } from "./tx";

export const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);
export const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
export const PSBT_IN_UTXO = 0x00;

/** Photonic caps the `psbt` envelope field at 65536 base64 characters. */
export const MAX_PSBT_BASE64_LEN = 65_536;

function writeVarInt(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, (value >> 8) & 0xff);
  if (value <= 0xffffffff) {
    return Uint8Array.of(
      0xfe,
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }
  throw new RangeError("PSBT varint out of range");
}

function keyValue(keyType: number, value: Uint8Array): Uint8Array {
  // Key types in this profile all fit one byte, so the key is just its type.
  const key = writeVarInt(keyType);
  return concatBytes(
    writeVarInt(key.length),
    key,
    writeVarInt(value.length),
    value,
  );
}

/** The bare `CTxOut` an input commits to: int64-LE value ‖ varint scriptPubKey. */
function serializeCTxOut(value: number, script: Uint8Array): Uint8Array {
  return concatBytes(
    writeInt64LE(value),
    writeVarInt(script.length),
    script,
  );
}

/** Serialize an unsigned transaction as a Radiant-profile PSBT. */
export function buildPsbt(tx: UnsignedTransaction): Uint8Array {
  const parts: Uint8Array[] = [PSBT_MAGIC];

  // Global map: the unsigned transaction, then the separator.
  parts.push(
    keyValue(PSBT_GLOBAL_UNSIGNED_TX, serializeUnsignedTx(tx)),
    Uint8Array.of(0x00),
  );

  // One map per input, each declaring the output it spends.
  for (const input of tx.inputs) {
    parts.push(
      keyValue(PSBT_IN_UTXO, serializeCTxOut(input.value, input.script)),
      Uint8Array.of(0x00),
    );
  }

  // One map per output. We add no entries, so each is just a separator.
  for (let i = 0; i < tx.outputs.length; i++) {
    parts.push(Uint8Array.of(0x00));
  }

  return concatBytes(...parts);
}

/** Standard padded base64, matching Radiant Core's `EncodeBase64`. */
export function psbtToBase64(psbt: Uint8Array): string {
  let binary = "";
  for (const byte of psbt) binary += String.fromCharCode(byte);
  return typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(psbt).toString("base64");
}

/** base64url, for carrying a PSBT inside a deep-link fragment. */
export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
