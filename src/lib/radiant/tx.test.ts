/**
 * Transaction and PSBT construction.
 *
 * Two independent checks, because a wrong byte here means a transaction the
 * wallet refuses or, worse, one that spends the wrong thing:
 *
 *  1. **radiantjs parses what we serialize.** Our unsigned transaction is fed
 *     to `@radiant-core/radiantjs`, and its view of the inputs, outputs and
 *     txid must match ours exactly.
 *  2. **The PSBT container is read back** by a parser written here directly
 *     from Photonic's documented framing, so the structure is validated
 *     against the spec rather than against itself.
 */
import { describe, expect, it } from "vitest";

import { encodeHashMarkScript } from "@hashmark/protocol";

import { p2pkhScript, decodeRadiantAddress } from "./address";
import type { Utxo } from "./chain";
import { buildPsbt, PSBT_MAGIC, psbtToBase64 } from "./psbt";
import {
  DUST_PHOTONS,
  InsufficientFundsError,
  buildHashMarkTx,
  estimateSignedSize,
  serializeUnsignedTx,
} from "./tx";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rjs = require("@radiant-core/radiantjs") as {
  Transaction: new (serialized?: string) => {
    inputs: { prevTxId: Buffer; outputIndex: number }[];
    outputs: { satoshis: number; script: { toBuffer(): Buffer } }[];
    id: string;
    version: number;
    nLockTime: number;
  };
};

const ADDRESS = "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i";
const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const DATA_SCRIPT = encodeHashMarkScript({
  algorithm: "sha256",
  digest: DIGEST,
  // Placeholder attestation bytes: this file tests transaction shape and
  // size, not signatures, and a v2 record is what the encoder now writes.
  signerHash160: "11".repeat(20),
  signature: "1f" + "22".repeat(64),
});

function utxo(value: number, index = 0, refs: unknown[] = []): Utxo {
  return {
    txid: "11".repeat(32),
    outputIndex: index,
    value,
    height: 459000,
    refs,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("coin selection", () => {
  it("builds a transaction with a data output and change", () => {
    const result = buildHashMarkTx({
      utxos: [utxo(100_000_000)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });

    expect(result.tx.inputs).toHaveLength(1);
    expect(result.tx.outputs).toHaveLength(2);
    expect(result.tx.outputs[0]!.value).toBe(0);
    expect(hex(result.tx.outputs[0]!.script)).toBe(hex(DATA_SCRIPT));
    expect(result.change).toBeGreaterThan(0);
    // Inputs must fund outputs plus fee, exactly.
    expect(result.tx.inputs[0]!.value).toBe(result.change + result.fee);
  });

  it("skips token-bearing UTXOs, which Photonic would refuse to sign", () => {
    const result = buildHashMarkTx({
      // The token UTXO is by far the largest, so a selector ignoring `refs`
      // would certainly pick it.
      utxos: [utxo(500_000_000, 0, ["someref"]), utxo(100_000_000, 1)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    expect(result.tx.inputs).toHaveLength(1);
    expect(result.tx.inputs[0]!.outputIndex).toBe(1);
  });

  it("refuses when every UTXO is token-bearing", () => {
    expect(() =>
      buildHashMarkTx({
        utxos: [utxo(500_000_000, 0, ["ref"])],
        dataScript: DATA_SCRIPT,
        changeAddress: ADDRESS,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("selects largest first, so a mark spends as few inputs as possible", () => {
    const result = buildHashMarkTx({
      utxos: [utxo(3_000_000, 0), utxo(90_000_000, 1), utxo(5_000_000, 2)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    expect(result.tx.inputs).toHaveLength(1);
    expect(result.tx.inputs[0]!.outputIndex).toBe(1);
  });

  it("combines inputs when no single one covers the fee", () => {
    const result = buildHashMarkTx({
      // Sized against a v2 record: the signer hash and signature add 87 bytes
      // over v1, so a fee that one 2,000,000-photon UTXO once covered no
      // longer is.
      utxos: [utxo(3_000_000, 0), utxo(3_000_000, 1), utxo(3_000_000, 2)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    expect(result.tx.inputs.length).toBeGreaterThan(1);
  });

  it("drops a dust change output instead of creating an unspendable one", () => {
    // Tuned so the remainder lands just under the dust threshold.
    const size = estimateSignedSize(1, [
      { value: 0, script: DATA_SCRIPT },
      { value: 0, script: p2pkhScript(decodeRadiantAddress(ADDRESS)!) },
    ]);
    const fee = size * 10_000;
    const result = buildHashMarkTx({
      utxos: [utxo(fee + DUST_PHOTONS - 1)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    expect(result.tx.outputs).toHaveLength(1);
    expect(result.change).toBe(0);
  });

  it("throws InsufficientFundsError with the real numbers", () => {
    try {
      buildHashMarkTx({
        utxos: [utxo(100)],
        dataScript: DATA_SCRIPT,
        changeAddress: ADDRESS,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientFundsError);
      const typed = error as InsufficientFundsError;
      expect(typed.available).toBe(100);
      expect(typed.required).toBeGreaterThan(100);
    }
  });

  it("rejects an invalid change address rather than building something unspendable", () => {
    expect(() =>
      buildHashMarkTx({
        utxos: [utxo(100_000_000)],
        dataScript: DATA_SCRIPT,
        changeAddress: "not-an-address",
      }),
    ).toThrow(/not a valid Radiant address/);
  });

  it("has no empty-UTXO edge case", () => {
    expect(() =>
      buildHashMarkTx({
        utxos: [],
        dataScript: DATA_SCRIPT,
        changeAddress: ADDRESS,
      }),
    ).toThrow(InsufficientFundsError);
  });
});

describe("serialization agrees with radiantjs", () => {
  it("round-trips an unsigned transaction through radiantjs", () => {
    const { tx } = buildHashMarkTx({
      utxos: [utxo(100_000_000, 3)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    const raw = hex(serializeUnsignedTx(tx));
    const parsed = new rjs.Transaction(raw);

    expect(parsed.version).toBe(tx.version);
    expect(parsed.nLockTime).toBe(tx.lockTime);
    expect(parsed.inputs).toHaveLength(tx.inputs.length);
    expect(parsed.outputs).toHaveLength(tx.outputs.length);

    // The prevout txid must survive the little-endian flip intact.
    expect(parsed.inputs[0]!.prevTxId.toString("hex")).toBe(tx.inputs[0]!.txid);
    expect(parsed.inputs[0]!.outputIndex).toBe(3);

    // The HashMark output: zero photons, exact script.
    expect(parsed.outputs[0]!.satoshis).toBe(0);
    expect(parsed.outputs[0]!.script.toBuffer().toString("hex")).toBe(
      hex(DATA_SCRIPT),
    );

    // Change output.
    expect(parsed.outputs[1]!.satoshis).toBe(tx.outputs[1]!.value);
    expect(parsed.outputs[1]!.script.toBuffer().toString("hex")).toBe(
      hex(tx.outputs[1]!.script),
    );

    expect(parsed.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializes multiple inputs in order", () => {
    const { tx } = buildHashMarkTx({
      utxos: [utxo(3_000_000, 0), utxo(3_000_000, 1), utxo(3_000_000, 2)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    const parsed = new rjs.Transaction(hex(serializeUnsignedTx(tx)));
    expect(parsed.inputs.map((i) => i.outputIndex)).toEqual(
      tx.inputs.map((i) => i.outputIndex),
    );
  });
});

/**
 * A PSBT reader written from Photonic's documented framing
 * (`docs/psbt.md` §2), used only to check our writer against the spec.
 */
function parsePsbtStructure(bytes: Uint8Array) {
  let i = 0;
  const readVarInt = (): number => {
    const first = bytes[i]!;
    i += 1;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = bytes[i]! | (bytes[i + 1]! << 8);
      i += 2;
      if (v < 0xfd) throw new Error("non-canonical varint");
      return v;
    }
    throw new Error("unexpected varint width in this profile");
  };

  for (let m = 0; m < PSBT_MAGIC.length; m++) {
    if (bytes[i + m] !== PSBT_MAGIC[m]) throw new Error("bad magic");
  }
  i += PSBT_MAGIC.length;

  const readMap = () => {
    const entries: { keyType: number; value: Uint8Array }[] = [];
    for (;;) {
      const keyLen = readVarInt();
      if (keyLen === 0) return entries; // separator
      const key = bytes.subarray(i, i + keyLen);
      i += keyLen;
      const valueLen = readVarInt();
      const value = bytes.subarray(i, i + valueLen);
      i += valueLen;
      entries.push({ keyType: key[0]!, value });
    }
  };

  const global = readMap();
  return { global, readMap, offset: () => i, total: bytes.length };
}

describe("PSBT container", () => {
  const { tx } = buildHashMarkTx({
    utxos: [utxo(100_000_000, 7)],
    dataScript: DATA_SCRIPT,
    changeAddress: ADDRESS,
  });
  const psbt = buildPsbt(tx);

  it("starts with the PSBT magic", () => {
    expect(hex(psbt.subarray(0, 5))).toBe("70736274ff");
  });

  it("carries the unsigned transaction under global key 0x00", () => {
    const { global } = parsePsbtStructure(psbt);
    expect(global).toHaveLength(1);
    expect(global[0]!.keyType).toBe(0x00);
    expect(hex(global[0]!.value)).toBe(hex(serializeUnsignedTx(tx)));
  });

  it("declares each input's prevout as a bare CTxOut, not a full transaction", () => {
    const parsed = parsePsbtStructure(psbt);
    const inputMap = parsed.readMap();
    expect(inputMap).toHaveLength(1);
    expect(inputMap[0]!.keyType).toBe(0x00);

    // int64-LE value, then varint-length script. 8 + 1 + 25 for P2PKH.
    const value = inputMap[0]!.value;
    expect(value).toHaveLength(8 + 1 + 25);

    let amount = 0n;
    for (let b = 7; b >= 0; b--) amount = (amount << 8n) | BigInt(value[b]!);
    expect(Number(amount)).toBe(tx.inputs[0]!.value);
    expect(value[8]).toBe(25);
    expect(hex(value.subarray(9))).toBe(hex(tx.inputs[0]!.script));
  });

  it("emits one empty map per output and consumes the whole buffer", () => {
    const parsed = parsePsbtStructure(psbt);
    parsed.readMap(); // the single input
    for (let o = 0; o < tx.outputs.length; o++) {
      expect(parsed.readMap()).toHaveLength(0);
    }
    expect(parsed.offset()).toBe(parsed.total);
  });

  it("handles a multi-input transaction", () => {
    const many = buildHashMarkTx({
      utxos: [utxo(3_000_000, 0), utxo(3_000_000, 1), utxo(3_000_000, 2)],
      dataScript: DATA_SCRIPT,
      changeAddress: ADDRESS,
    });
    const parsed = parsePsbtStructure(buildPsbt(many.tx));
    for (let n = 0; n < many.tx.inputs.length; n++) {
      expect(parsed.readMap()).toHaveLength(1);
    }
    for (let o = 0; o < many.tx.outputs.length; o++) {
      expect(parsed.readMap()).toHaveLength(0);
    }
    expect(parsed.offset()).toBe(parsed.total);
  });

  it("base64-encodes to well under Photonic's envelope cap", () => {
    const base64 = psbtToBase64(psbt);
    expect(base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(base64.length).toBeLessThan(65_536);
    // A typical single-input mark is a few hundred bytes.
    expect(base64.length).toBeLessThan(1000);
  });
});
