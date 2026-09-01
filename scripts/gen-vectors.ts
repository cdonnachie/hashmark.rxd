/**
 * Regenerates the test vectors quoted in HASHMARK_PROTOCOL.md and
 * docs/RXINDEXER_HASHMARK_INDEX.md, and cross-checks each one against
 * @radiant-core/radiantjs.
 *
 * Run with `pnpm vectors`. If the output disagrees with what those documents
 * say, the documents are wrong — fix them, or bump the protocol version if the
 * format really did change.
 */
import { createHash } from "node:crypto";

import {
  bytesToHex,
  decodeHashMarkScript,
  encodeLegacyV1Script,
} from "../packages/protocol/src/index";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rjs = require("@radiant-core/radiantjs") as {
  Script: { buildDataOut(data: Buffer[]): { toBuffer(): Buffer } };
};

function radiantjsHex(digestHex: string, label?: string): string {
  const pushes = [
    Buffer.from("HASHMARK", "ascii"),
    Buffer.from([1, 1]),
    Buffer.from(digestHex, "hex"),
  ];
  if (label !== undefined) pushes.push(Buffer.from(label, "utf8"));
  return rjs.Script.buildDataOut(pushes).toBuffer().toString("hex");
}

function show(title: string, digest: string, label?: string): void {
  const script = encodeLegacyV1Script({
    algorithm: "sha256",
    digest,
    ...(label === undefined ? {} : { label }),
  });
  const hex = bytesToHex(script);
  const reference = radiantjsHex(digest, label);
  const decoded = decodeHashMarkScript(script);

  console.log(`\n── ${title} ──`);
  console.log(`bytes            : ${script.length}`);
  console.log(`scriptPubKey hex : ${hex}`);
  console.log(`radiantjs agrees : ${hex === reference ? "yes" : "NO — MISMATCH"}`);
  console.log(
    `decodes to       : ${decoded.ok ? JSON.stringify(decoded.record) : JSON.stringify(decoded)}`,
  );
  if (hex !== reference) process.exitCode = 1;
}

// The digest used in the protocol document's worked example.
const testDigest = createHash("sha256").update("test").digest("hex");
console.log(`SHA-256("test") = ${testDigest}`);

show("§13.1 worked example (label 'Contract draft')", testDigest, "Contract draft");
show("§13.3 minimal record, no label", "aa".repeat(32));
show("with label 'hi'", "aa".repeat(32), "hi");

console.log("\n── rejection vectors ──");
const rejects: [string, string][] = [
  ["P2PKH", `76a914${"00".repeat(20)}88ac`],
  ["mainnet OP_RETURN \"msg\"", "6a036d736706736e6b00336b"],
  ["non-minimal push", `6a0848415348${"4d41524b"}0201014c20${"aa".repeat(32)}`],
  ["digest 31 bytes", `6a0848415348${"4d41524b"}0201011f${"aa".repeat(31)}`],
  ["header 1 byte", `6a0848415348${"4d41524b"}010120${"aa".repeat(32)}`],
  ["version 2", `6a0848415348${"4d41524b"}02020120${"aa".repeat(32)}`],
  ["algorithm 2", `6a0848415348${"4d41524b"}02010220${"aa".repeat(32)}`],
  ["label not UTF-8", `6a0848415348${"4d41524b"}02010120${"aa".repeat(32)}02fffe`],
  ["label control char", `6a0848415348${"4d41524b"}02010120${"aa".repeat(32)}03610a62`],
  [
    "five pushes",
    `6a0848415348${"4d41524b"}02010120${"aa".repeat(32)}026f6b03010203`,
  ],
];
for (const [name, hex] of rejects) {
  const result = decodeHashMarkScript(Uint8Array.from(Buffer.from(hex, "hex")));
  const outcome = result.ok ? "ACCEPTED — BUG" : result.reason;
  console.log(`${name.padEnd(26)} → ${outcome}`);
  if (result.ok) process.exitCode = 1;
}
