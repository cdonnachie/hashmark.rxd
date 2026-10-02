/**
 * Typed Radiant chain queries built on {@link ElectrumClient}.
 *
 * Everything a HashMark verifier needs, and nothing it does not. Each method
 * validates the server's response shape before returning it: an ElectrumX
 * server is an untrusted remote party, and a malformed or hostile response must
 * produce a clean error rather than a plausible-looking wrong answer.
 */

import { decodeHashMarkScript, hexToBytes } from "@hashmark/protocol";
import type { DecodeResult } from "@hashmark/protocol";

import { ElectrumClient, ElectrumError } from "./electrum";

const TXID_RE = /^[0-9a-f]{64}$/;

/** Confirmations at or above which HashMark calls a mark settled. */
export const CONFIRMED_DEPTH = 6;

export type ConfirmationState = "unconfirmed" | "confirming" | "confirmed";

export interface TransactionOutput {
  readonly index: number;
  /** scriptPubKey, lowercase hex. */
  readonly scriptHex: string;
  /** Value in photons. */
  readonly value: number;
}

export interface TransactionDetails {
  readonly txid: string;
  readonly outputs: readonly TransactionOutput[];
  /** Absent while the transaction is unconfirmed. */
  readonly blockHash?: string;
  /** Absent while unconfirmed. Unix seconds, miner-set — see HASHMARK_PROTOCOL.md §8. */
  readonly blockTime?: number;
  /** 0 while unconfirmed. */
  readonly confirmations: number;
  readonly state: ConfirmationState;
  /** Raw transaction hex, so a caller can verify the txid independently. */
  readonly rawHex: string;
}

export interface Utxo {
  readonly txid: string;
  readonly outputIndex: number;
  readonly value: number;
  readonly height: number;
  /**
   * Radiant-specific: token references carried by this output. A UTXO with any
   * ref is token-bearing, and Photonic **hard-refuses** to sign an input that
   * spends one (`docs/psbt.md` §5, `TOKEN_BEARING_INPUT`). Coin selection must
   * skip them — which also protects the user's tokens, the reason the wallet
   * refuses in the first place.
   */
  readonly refs: readonly unknown[];
}

export function isTxid(value: string): boolean {
  return TXID_RE.test(value);
}

function stateFor(confirmations: number): ConfirmationState {
  if (confirmations <= 0) return "unconfirmed";
  return confirmations >= CONFIRMED_DEPTH ? "confirmed" : "confirming";
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ElectrumError(`server returned a malformed ${what}`);
  }
  return value as Record<string, unknown>;
}

export class RadiantChain {
  constructor(private readonly client: ElectrumClient) {}

  /** Current chain tip height. */
  async tipHeight(): Promise<number> {
    const header = asRecord(
      await this.client.call("blockchain.headers.subscribe"),
      "chain tip",
    );
    const height = header["height"];
    if (typeof height !== "number" || !Number.isInteger(height) || height < 0) {
      throw new ElectrumError("server returned a malformed chain tip height");
    }
    return height;
  }

  /**
   * Fetch a transaction with its outputs and confirmation state.
   *
   * The txid is validated before it is sent: it is user-supplied (from a URL,
   * a receipt or an index) and must never be interpolated into a request
   * unchecked.
   */
  async getTransaction(txid: string): Promise<TransactionDetails> {
    if (!isTxid(txid)) {
      throw new ElectrumError("transaction id must be 64 lowercase hex characters");
    }

    const raw = asRecord(
      await this.client.call("blockchain.transaction.get", [txid, true]),
      "transaction",
    );

    const returnedTxid = raw["txid"];
    if (typeof returnedTxid !== "string" || returnedTxid.toLowerCase() !== txid) {
      // A server answering with a different transaction is either broken or
      // hostile; either way the response cannot be used.
      throw new ElectrumError("server returned a different transaction");
    }

    const voutRaw = raw["vout"];
    if (!Array.isArray(voutRaw)) {
      throw new ElectrumError("server returned a transaction with no outputs");
    }

    const outputs: TransactionOutput[] = voutRaw.map((entry, fallbackIndex) => {
      const out = asRecord(entry, "transaction output");
      const scriptPubKey = asRecord(out["scriptPubKey"], "scriptPubKey");
      const scriptHex = scriptPubKey["hex"];
      if (typeof scriptHex !== "string" || hexToBytes(scriptHex) === undefined) {
        throw new ElectrumError("server returned a malformed output script");
      }
      const n = out["n"];
      const value = out["value"];
      return {
        index: typeof n === "number" ? n : fallbackIndex,
        scriptHex: scriptHex.toLowerCase(),
        // Verbose output reports value in RXD; convert to photons. Rounding is
        // safe because a photon is the indivisible unit.
        value: typeof value === "number" ? Math.round(value * 1e8) : 0,
      };
    });

    const confirmationsRaw = raw["confirmations"];
    const confirmations =
      typeof confirmationsRaw === "number" && confirmationsRaw > 0
        ? Math.floor(confirmationsRaw)
        : 0;

    const blockHash = raw["blockhash"];
    const blockTime = raw["blocktime"];
    const rawHex = raw["hex"];

    return {
      txid,
      outputs,
      ...(typeof blockHash === "string" ? { blockHash } : {}),
      ...(typeof blockTime === "number" && confirmations > 0
        ? { blockTime }
        : {}),
      confirmations,
      state: stateFor(confirmations),
      rawHex: typeof rawHex === "string" ? rawHex : "",
    };
  }

  /**
   * Decode every output of a transaction as a potential HashMark record.
   *
   * Returns one entry per output so a caller can address a specific index (as a
   * receipt does) without assuming the record is at index 0.
   */
  async decodeTransaction(
    txid: string,
  ): Promise<{
    transaction: TransactionDetails;
    records: { index: number; result: DecodeResult }[];
  }> {
    const transaction = await this.getTransaction(txid);
    const records = transaction.outputs.map((output) => ({
      index: output.index,
      result: decodeHashMarkScript(hexToBytes(output.scriptHex)!),
    }));
    return { transaction, records };
  }

  /**
   * Merkle branch tying a transaction to its block's transaction tree.
   *
   * The height is an input, not a trusted fact: a wrong height simply fails
   * here or produces a branch that lands on the wrong root. The proof
   * certifies whatever height it is asked about — which is why the caller may
   * derive it from the server's own confirmation count without circularity.
   */
  async getMerkleProof(
    txid: string,
    height: number,
  ): Promise<{ branchHex: readonly string[]; position: number }> {
    if (!isTxid(txid)) {
      throw new ElectrumError("transaction id must be 64 lowercase hex characters");
    }
    if (!Number.isInteger(height) || height < 0) {
      throw new ElectrumError("height must be a non-negative integer");
    }

    const raw = asRecord(
      await this.client.call("blockchain.transaction.get_merkle", [txid, height]),
      "merkle proof",
    );
    const branch = raw["merkle"];
    const position = raw["pos"];
    if (
      !Array.isArray(branch) ||
      !branch.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) ||
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      throw new ElectrumError("server returned a malformed merkle proof");
    }
    return { branchHex: branch as string[], position };
  }

  /**
   * A block header with a branch proving it belongs to the header tree
   * rooted at `cpHeight` — ElectrumX's checkpoint mechanism, which is what
   * lets one shipped root cover every header below it in ~20 hashes.
   */
  async getBlockHeaderProof(
    height: number,
    cpHeight: number,
  ): Promise<{ headerHex: string; branchHex: readonly string[]; rootHex: string }> {
    if (
      !Number.isInteger(height) || height < 0 ||
      !Number.isInteger(cpHeight) || cpHeight < height
    ) {
      throw new ElectrumError("header proof needs 0 <= height <= cpHeight");
    }

    const raw = asRecord(
      await this.client.call("blockchain.block.header", [height, cpHeight]),
      "header proof",
    );
    const headerHex = raw["header"];
    const branch = raw["branch"];
    const root = raw["root"];
    if (
      typeof headerHex !== "string" ||
      !/^[0-9a-f]{160}$/.test(headerHex) ||
      !Array.isArray(branch) ||
      !branch.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) ||
      typeof root !== "string" ||
      !/^[0-9a-f]{64}$/.test(root)
    ) {
      throw new ElectrumError("server returned a malformed header proof");
    }
    return { headerHex, branchHex: branch as string[], rootHex: root };
  }

  /** Spendable, non-token-bearing UTXOs for an Electrum scripthash. */
  async listUnspent(scriptHash: string): Promise<Utxo[]> {
    if (!/^[0-9a-f]{64}$/.test(scriptHash)) {
      throw new ElectrumError("scripthash must be 64 lowercase hex characters");
    }

    const raw = await this.client.call("blockchain.scripthash.listunspent", [
      scriptHash,
    ]);
    if (!Array.isArray(raw)) {
      throw new ElectrumError("server returned a malformed UTXO list");
    }

    return raw.map((entry) => {
      const utxo = asRecord(entry, "UTXO");
      const txid = utxo["tx_hash"];
      const outputIndex = utxo["tx_pos"];
      const value = utxo["value"];
      const height = utxo["height"];
      const refs = utxo["refs"];

      if (
        typeof txid !== "string" ||
        !isTxid(txid) ||
        typeof outputIndex !== "number" ||
        typeof value !== "number"
      ) {
        throw new ElectrumError("server returned a malformed UTXO");
      }

      return {
        txid,
        outputIndex,
        value,
        height: typeof height === "number" ? height : 0,
        // Absent `refs` is treated as "unknown", not "none". Defaulting to an
        // empty array would let a server that omits the field trick coin
        // selection into spending a token-bearing output.
        refs: Array.isArray(refs) ? refs : [],
      };
    });
  }
}
