/**
 * Prove `@hashmark/protocol` works as a published package.
 *
 * The unit tests import it through a tsconfig path alias, which resolves to
 * TypeScript source and hides whether the *built* output would actually load.
 * This imports `dist/` the way a stranger would: plain Node ESM, no bundler, no
 * alias, no transpiler. If the emitted specifiers are wrong, this fails and the
 * unit tests would not have noticed.
 *
 * Run with `pnpm test:package`.
 */
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";

const dist = pathToFileURL(
  new URL("../packages/protocol/dist/index.js", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  ),
).href;

const protocol = await import(dist);

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const SIGNER = "26ba056431ec69cf27eabeaab250d99ddbd895d2";
const SIGNATURE = "1f" + "ab".repeat(64);

const script = protocol.encodeHashMarkScript({
  algorithm: "sha256",
  digest: DIGEST,
  label: "Contract draft",
  signerHash160: SIGNER,
  signature: SIGNATURE,
});
assert.equal(
  protocol.bytesToHex(script),
  "6a08484153484d41524b02020120" +
    DIGEST +
    "14" +
    SIGNER +
    "41" +
    SIGNATURE +
    "0e436f6e7472616374206472616674",
  "built package must encode identically to the source",
);

const decoded = protocol.decodeHashMarkScript(script);
assert.ok(decoded.ok, "built package must decode its own output");
assert.equal(decoded.record.version, 2);
assert.equal(decoded.record.digest, DIGEST);
assert.equal(decoded.record.label, "Contract draft");
assert.equal(decoded.record.signerHash160, SIGNER);
assert.equal(decoded.record.signature, SIGNATURE);

// v1 records are permanent, so the built package must still read them.
const v1 = protocol.encodeLegacyV1Script({ algorithm: "sha256", digest: DIGEST });
const v1Decoded = protocol.decodeHashMarkScript(v1);
assert.ok(v1Decoded.ok, "built package must still decode v1 records");
assert.equal(v1Decoded.record.version, 1);
assert.equal(v1Decoded.record.signerHash160, undefined);

// The statement a v2 signature covers must be reproducible from the package
// alone — that is the whole point of shipping it dependency-free.
const statement = protocol.canonicalAttestationMessage({
  genesisHash: protocol.RADIANT_MAINNET.genesisHash,
  signerHash160: SIGNER,
  algorithmId: 1,
  digest: DIGEST,
});
assert.ok(
  statement.startsWith('{"v":"HashMark/v2","network":"'),
  "canonical statement must be the documented single-line JSON",
);
assert.ok(
  !statement.includes(String.fromCharCode(10)),
  "the statement must be one line",
);

// A real mainnet OP_RETURN belonging to another protocol.
assert.equal(
  protocol.decodeHashMarkScript(
    Uint8Array.from(Buffer.from("6a036d736706736e6b00336b", "hex")),
  ).reason,
  "NOT_HASHMARK",
);

const receipt = protocol.buildReceipt({
  network: protocol.RADIANT_MAINNET,
  algorithm: "sha256",
  digest: DIGEST,
  transactionId: "b".repeat(64),
  outputIndex: 0,
});
assert.ok(protocol.parseReceipt(protocol.serializeReceipt(receipt)).ok);

// Every name the documentation tells a third party to use must be exported.
for (const name of [
  "encodeHashMarkScript",
  "decodeHashMarkScript",
  "buildReceipt",
  "parseReceipt",
  "serializeReceipt",
  "validateReceipt",
  "supportedAlgorithms",
  "canonicalAttestationMessage",
  "encodeLegacyV1Script",
  "labelDefect",
  "maxLabelBytes",
  "RADIANT_MAINNET",
  "PROTOCOL_VERSION",
  "SUPPORTED_VERSIONS",
  "MAX_LABEL_BYTES",
  "MAX_LABEL_BYTES_V1",
]) {
  assert.ok(name in protocol, `built package is missing the export "${name}"`);
}

console.log(
  "@hashmark/protocol imports and behaves correctly as plain Node ESM.",
);
