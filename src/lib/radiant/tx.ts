/**
 * Unsigned Radiant transaction construction and coin selection.
 *
 * HashMark **never signs anything**, so this only ever produces an *unsigned*
 * transaction. That is what makes hand-rolling it safe: an unsigned legacy
 * transaction is plain serialization, with no sighash, no key handling and no
 * cryptography. Radiant's FORKID sighash — the genuinely subtle part — is the
 * wallet's business, and stays there.
 *
 * Byte layout (legacy Bitcoin serialization; Radiant has no segwit):
 *
 *   int32LE   version
 *   varint    input count
 *   per input: 32B prevTxid (reversed) | uint32LE vout | varint scriptSig | uint32LE sequence
 *   varint    output count
 *   per output: int64LE value | varint scriptPubKey
 *   uint32LE  locktime
 */

import { concatBytes, hexToBytes } from "@hashmark/protocol";

import { FEE_RATE_PHOTONS_PER_BYTE } from "@/lib/config";

import { p2pkhScript, decodeRadiantAddress } from "./address";
import type { Utxo } from "./chain";

export const TX_VERSION = 2;
/** Final: no replace-by-fee. A timestamp should not be replaceable after the fact. */
export const SEQUENCE_FINAL = 0xffffffff;
/** Below this an output is dust and would be rejected. */
export const DUST_PHOTONS = 546;

export interface TxInput {
  readonly txid: string;
  readonly outputIndex: number;
  readonly value: number;
  /** The scriptPubKey being spent, needed for the PSBT's declared prevout. */
  readonly script: Uint8Array;
}

export interface TxOutput {
  readonly value: number;
  readonly script: Uint8Array;
}

export interface UnsignedTransaction {
  readonly inputs: readonly TxInput[];
  readonly outputs: readonly TxOutput[];
  readonly version: number;
  readonly lockTime: number;
}

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
  const out = new Uint8Array(9);
  out[0] = 0xff;
  let big = BigInt(value);
  for (let i = 1; i <= 8; i++) {
    out[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return out;
}

function writeUInt32LE(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

/** Values can exceed 2^53 in theory, so amounts are serialized via BigInt. */
export function writeInt64LE(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  let big = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return out;
}

function writeVarSlice(bytes: Uint8Array): Uint8Array {
  return concatBytes(writeVarInt(bytes.length), bytes);
}

/** A txid displayed big-endian is stored little-endian in a transaction. */
function txidToPrevHash(txid: string): Uint8Array {
  const bytes = hexToBytes(txid);
  if (bytes === undefined || bytes.length !== 32) {
    throw new Error(`invalid txid: ${txid}`);
  }
  return bytes.slice().reverse();
}

/**
 * Serialize the transaction with every scriptSig empty — the form a PSBT's
 * `PSBT_GLOBAL_UNSIGNED_TX` requires.
 */
export function serializeUnsignedTx(tx: UnsignedTransaction): Uint8Array {
  const parts: Uint8Array[] = [
    writeUInt32LE(tx.version),
    writeVarInt(tx.inputs.length),
  ];

  for (const input of tx.inputs) {
    parts.push(
      txidToPrevHash(input.txid),
      writeUInt32LE(input.outputIndex),
      writeVarInt(0), // empty scriptSig
      writeUInt32LE(SEQUENCE_FINAL),
    );
  }

  parts.push(writeVarInt(tx.outputs.length));
  for (const output of tx.outputs) {
    parts.push(writeInt64LE(output.value), writeVarSlice(output.script));
  }

  parts.push(writeUInt32LE(tx.lockTime));
  return concatBytes(...parts);
}

/**
 * Estimated signed size in bytes.
 *
 * A P2PKH input costs 32 + 4 + 1 + ~107 + 4 ≈ 148 bytes once its scriptSig
 * holds a DER signature and a compressed pubkey. Deliberately rounded up: an
 * underestimate produces a fee too low and a transaction that will not relay,
 * while an overestimate costs a fraction of a penny.
 */
export function estimateSignedSize(
  inputCount: number,
  outputs: readonly TxOutput[],
): number {
  const base = 4 + 4; // version + locktime
  const counts = writeVarInt(inputCount).length + writeVarInt(outputs.length).length;
  const inputs = inputCount * 148;
  const outputBytes = outputs.reduce(
    (total, output) => total + 8 + writeVarInt(output.script.length).length + output.script.length,
    0,
  );
  return base + counts + inputs + outputBytes;
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(
      `Not enough RXD. This mark needs about ${required.toLocaleString()} photons, and the wallet has ${available.toLocaleString()}.`,
    );
    this.name = "InsufficientFundsError";
  }
}

export interface BuildResult {
  readonly tx: UnsignedTransaction;
  readonly fee: number;
  readonly estimatedSize: number;
  /** Photons returned to the user, or 0 when the remainder was dust. */
  readonly change: number;
}

/**
 * Build the HashMark transaction: the data output, plus change back to the
 * wallet's own address.
 *
 * Coin selection is deliberately simple — largest first, so a mark spends as
 * few inputs as possible and stays cheap. Anything cleverer (privacy-aware
 * selection, consolidation) belongs in a wallet, not here.
 */
export function buildHashMarkTx(options: {
  utxos: readonly Utxo[];
  /** The scriptPubKey of the HashMark output. Carries 0 photons. */
  dataScript: Uint8Array;
  /** Where change goes. Must be the address that will sign. */
  changeAddress: string;
  feeRate?: number;
}): BuildResult {
  const feeRate = options.feeRate ?? FEE_RATE_PHOTONS_PER_BYTE;

  const changeHash160 = decodeRadiantAddress(options.changeAddress);
  if (changeHash160 === undefined) {
    throw new Error("change address is not a valid Radiant address");
  }
  const changeScript = p2pkhScript(changeHash160);

  // Token-bearing UTXOs are excluded before anything else. Photonic refuses to
  // sign an input spending one, and spending a token to pay a fee would destroy
  // it. See chain.ts `Utxo.refs`.
  const spendable = options.utxos
    .filter((utxo) => utxo.refs.length === 0 && utxo.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value);

  const available = spendable.reduce((sum, utxo) => sum + utxo.value, 0);

  const dataOutput: TxOutput = { value: 0, script: options.dataScript };

  const chosen: Utxo[] = [];
  let total = 0;

  for (const utxo of spendable) {
    chosen.push(utxo);
    total += utxo.value;

    // Price the transaction as if it needs change, since it usually will.
    const withChange = estimateSignedSize(chosen.length, [
      dataOutput,
      { value: 0, script: changeScript },
    ]);
    const feeWithChange = Math.ceil(withChange * feeRate);

    if (total >= feeWithChange) {
      const remainder = total - feeWithChange;

      if (remainder >= DUST_PHOTONS) {
        return {
          tx: {
            version: TX_VERSION,
            lockTime: 0,
            inputs: chosen.map(toInput),
            outputs: [dataOutput, { value: remainder, script: changeScript }],
          },
          fee: feeWithChange,
          estimatedSize: withChange,
          change: remainder,
        };
      }

      // Change would be dust. Drop the output and let the remainder go to fee
      // rather than creating an unspendable one.
      const withoutChange = estimateSignedSize(chosen.length, [dataOutput]);
      const feeWithoutChange = Math.ceil(withoutChange * feeRate);
      if (total >= feeWithoutChange) {
        return {
          tx: {
            version: TX_VERSION,
            lockTime: 0,
            inputs: chosen.map(toInput),
            outputs: [dataOutput],
          },
          fee: total,
          estimatedSize: withoutChange,
          change: 0,
        };
      }
    }
  }

  const needed = Math.ceil(
    estimateSignedSize(Math.max(spendable.length, 1), [
      dataOutput,
      { value: 0, script: changeScript },
    ]) * feeRate,
  );
  throw new InsufficientFundsError(needed, available);

  function toInput(utxo: Utxo): TxInput {
    return {
      txid: utxo.txid,
      outputIndex: utxo.outputIndex,
      value: utxo.value,
      script: changeScript, // every selected UTXO pays to the signing address
    };
  }
}
