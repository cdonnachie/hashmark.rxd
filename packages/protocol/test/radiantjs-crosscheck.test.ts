/**
 * Cross-validation against `@radiant-core/radiantjs`.
 *
 * HashMark deliberately does **not** depend on radiantjs at runtime (see
 * docs/PHASE1_ARCHITECTURE.md §6): the protocol package is dependency-free so a
 * third-party verifier can use it anywhere. That freedom is only safe if our
 * hand-rolled push encoder produces byte-identical output to the reference
 * Radiant library, so this test holds the two against each other.
 *
 * radiantjs is a devDependency, used here and nowhere else.
 *
 * Note the asymmetry: we check radiantjs's *encoder* against ours, but not its
 * decoder. `Script.prototype.getData()` returns only the FIRST push for a bare
 * `OP_RETURN` output (`lib/script/script.js:729` — it returns every push only
 * for the `OP_FALSE OP_RETURN` "safe data out" form, which Radiant Core's
 * standardness rules reject). Decoding is ours alone, and is covered in
 * protocol.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_LABEL_BYTES,
  bytesToHex,
  encodeLegacyV1Script,
  utf8ToBytes,
} from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rjs = require("@radiant-core/radiantjs") as {
  Script: {
    buildDataOut(data: Buffer[]): { toBuffer(): Buffer };
  };
  Transaction: new () => {
    addData(value: Buffer[]): unknown;
    outputs: { satoshis: number; script: { isDataOut(): boolean } }[];
  };
};

/** The same record, built the radiantjs way. */
function radiantjsScriptHex(pushes: Uint8Array[]): string {
  const script = rjs.Script.buildDataOut(pushes.map((p) => Buffer.from(p)));
  return script.toBuffer().toString("hex");
}

function hashMarkPushes(digestHex: string, label?: string): Uint8Array[] {
  const pushes: Uint8Array[] = [
    utf8ToBytes("HASHMARK"),
    Uint8Array.of(1, 1),
    Uint8Array.from(Buffer.from(digestHex, "hex")),
  ];
  if (label !== undefined) pushes.push(utf8ToBytes(label.normalize("NFC")));
  return pushes;
}

describe("radiantjs cross-check", () => {
  const digest = "a".repeat(64);

  it("byte-matches radiantjs for a record with no label", () => {
    const ours = bytesToHex(
      encodeLegacyV1Script({ algorithm: "sha256", digest }),
    );
    expect(ours).toBe(radiantjsScriptHex(hashMarkPushes(digest)));
  });

  it("byte-matches radiantjs across every label length boundary", () => {
    // 75/76 straddles direct-push vs OP_PUSHDATA1 — the boundary most likely
    // to diverge between two independent encoders.
    for (const length of [1, 2, 74, 75, 76, 77, 127, MAX_LABEL_BYTES]) {
      const label = "z".repeat(length);
      const ours = bytesToHex(
        encodeLegacyV1Script({ algorithm: "sha256", digest, label }),
      );
      expect(ours, `label length ${length}`).toBe(
        radiantjsScriptHex(hashMarkPushes(digest, label)),
      );
    }
  });

  it("byte-matches radiantjs for a multi-byte UTF-8 label", () => {
    const label = "Проверка ✓ 日本語 🐟";
    const ours = bytesToHex(
      encodeLegacyV1Script({ algorithm: "sha256", digest, label }),
    );
    expect(ours).toBe(radiantjsScriptHex(hashMarkPushes(digest, label)));
  });

  it("radiantjs agrees the output is a standard data output at zero value", () => {
    // This is the property Radiant Core's Solver() keys on: a bare OP_RETURN
    // whose remainder is push-only is TX_NULL_DATA, which is standard AND
    // exempt from the dust rule, so a 0-photon output is legal.
    const tx = new rjs.Transaction();
    tx.addData(hashMarkPushes(digest, "hello").map((p) => Buffer.from(p)));
    const output = tx.outputs[0]!;
    expect(output.satoshis).toBe(0);
    expect(output.script.isDataOut()).toBe(true);
  });
});
