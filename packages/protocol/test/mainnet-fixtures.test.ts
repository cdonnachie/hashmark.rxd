/**
 * Real HashMark records, taken from Radiant mainnet.
 *
 * These are not constructed examples. Each `script` below is the exact
 * `scriptPubKey` hex of a confirmed mainnet output, copied verbatim from a
 * node, and each can be re-read from the chain by anyone with the transaction
 * id beside it.
 *
 * ## Why they are here
 *
 * The same three records are in `pyrxd`'s test suite. pyrxd's HashMark verifier
 * was written from `HASHMARK_PROTOCOL.md` alone, by a different developer, in a
 * different language, without reference to this code — and it read these
 * records identically the first time it ran.
 *
 * That makes them a shared conformance anchor rather than our own regression
 * test. If this implementation ever drifts from the specification, these fail
 * here; if pyrxd drifts, they fail there. Neither of us can move the format
 * without the other noticing, which is the property that makes an independently
 * implementable spec worth having.
 *
 * **Do not regenerate these to make a test pass.** They are fixed points. A
 * failure here means either the decoder changed behaviour or the specification
 * did — and the second one requires a protocol version bump, not an edit to
 * this file.
 *
 * These tests are offline by design: the bytes are pinned, so nothing here
 * depends on a node being reachable. `scripts/find-marks.ts` does the live
 * equivalent.
 */
import { describe, expect, it } from "vitest";

import {
  RADIANT_MAINNET,
  bytesToHex,
  canonicalAttestationMessage,
  decodeHashMarkScript,
  encodeHashMarkScript,
  hexToBytes,
} from "../src/index.js";

interface MainnetFixture {
  readonly name: string;
  readonly txid: string;
  /** Block time of the containing block, Unix seconds. */
  readonly blockTime: number;
  /** scriptPubKey hex, exactly as the chain holds it. */
  readonly script: string;
  readonly version: number;
  readonly digest: string;
  readonly label?: string;
  readonly signerHash160?: string;
  /** Which implementation wrote it. See the pyrxd entry below. */
  readonly writtenBy?: string;
}

const FIXTURES: readonly MainnetFixture[] = [
  {
    name: "v1, no label — the first HashMark on mainnet",
    txid: "345565ebbf97d53ffc7d553409cddd326d970bf3b22f78c0393b49c419588892",
    blockTime: 1788071167,
    script:
      "6a08484153484d41524b02010120e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e",
    version: 1,
    digest: "e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e",
  },
  {
    name: "v1, no label — a different file",
    txid: "6bd142ade078184a9c91fefe4ef3b08ffdadd5a230e9e1a97de00f3293913209",
    blockTime: 1788207029,
    script:
      "6a08484153484d41524b0201012049f82c41b6d6c78dbffe0df9014177b1b423171b5b6b7e09cccb68e4746dbc05",
    version: 1,
    digest: "49f82c41b6d6c78dbffe0df9014177b1b423171b5b6b7e09cccb68e4746dbc05",
  },
  {
    name: "v2, signed — the same file as the first, attested",
    txid: "a1a86ab4503901af4df3d092fcf668b07c03c5cd89240fe918ae70e02e045916",
    blockTime: 1788272741,
    script:
      "6a08484153484d41524b02020120e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e" +
      "1426ba056431ec69cf27eabeaab250d99ddbd895d2" +
      "411f750d18df9ab44ba66ced01285a5a067b9ebf7c8ff6b32dddb40cc276c5e98d4c2054937e44a40d7628d80cafdd6a372b0aae8f8bb31dbb4d975273a23e8c9771",
    version: 2,
    digest: "e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e",
    signerHash160: "26ba056431ec69cf27eabeaab250d99ddbd895d2",
    writtenBy: "hashmark.rxd",
  },
  {
    // The most valuable fixture in this file, because we did not write it.
    // pyrxd's encoder was built from HASHMARK_PROTOCOL.md without reference to
    // this code, so this record tests that we can read output from a foreign
    // implementation rather than only our own. It is also the only labelled v2
    // record here, which exercises the label-at-push-5 path on real bytes.
    //
    // It marks the pyrxd 0.25.1 wheel. The digest below is the sha256 of the
    // 1,722,880-byte file PyPI serves for pyrxd-0.25.1-py3-none-any.whl —
    // checked by hashing the artifact, not by trusting PyPI's own digest.
    name: "v2, signed, labelled — written by pyrxd, a different implementation",
    txid: "aa66b04662aa5514ed7d0027ff3cbd608d73f3e2b92d4129d810eb576bc0c86e",
    blockTime: 1790714023,
    script:
      "6a08484153484d41524b02020120f57d61113ec9601660b8c39b23b0aae8c4885c9fd8f7781a4c7f02b79dc0fc2c" +
      "1443ed516d7debe4804d46b192b5452c8e1cc8752041" +
      "1fc3a50a79ca8abca7262d1f6932b074ff51376802353ae03c26ef0015bf03966a7d3d7de2286974c5c739e68469695457dd220408677ed221a3c81c748f2f8d2d" +
      "27707972786420302e32352e3120776865656c206173207075626c6973686564206f6e2050795049",
    version: 2,
    digest: "f57d61113ec9601660b8c39b23b0aae8c4885c9fd8f7781a4c7f02b79dc0fc2c",
    label: "pyrxd 0.25.1 wheel as published on PyPI",
    signerHash160: "43ed516d7debe4804d46b192b5452c8e1cc87520",
    writtenBy: "pyrxd",
  },
];

describe("mainnet fixtures", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    "decodes %s",
    (_name, fixture) => {
      const bytes = hexToBytes(fixture.script);
      expect(bytes, "fixture script must be valid hex").toBeDefined();

      const result = decodeHashMarkScript(bytes!);
      expect(result.ok, `${fixture.txid} must decode`).toBe(true);
      if (!result.ok) return;

      expect(result.record.version).toBe(fixture.version);
      expect(result.record.digest).toBe(fixture.digest);
      expect(result.record.algorithm).toBe("sha256");
      expect(result.record.algorithmId).toBe(1);
    },
  );

  it("reads the committed signer of every v2 record", () => {
    for (const signed of FIXTURES.filter((f) => f.version === 2)) {
      const result = decodeHashMarkScript(hexToBytes(signed.script)!);
      expect(result.ok, signed.txid).toBe(true);
      if (!result.ok) continue;

      expect(result.record.signerHash160).toBe(signed.signerHash160);
      // 65 bytes: header || r || s.
      expect(result.record.signature).toHaveLength(130);
      expect(result.record.label).toBe(signed.label);
    }
  });

  it("re-emits a foreign implementation's record byte for byte", () => {
    // The interop check our own records cannot make. pyrxd's encoder and this
    // one were written from the same document and never from each other; if
    // either drifts on push encoding, field order or the label position, these
    // bytes stop matching.
    const foreign = FIXTURES.find((f) => f.writtenBy === "pyrxd")!;
    const result = decodeHashMarkScript(hexToBytes(foreign.script)!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reEmitted = bytesToHex(
      encodeHashMarkScript({
        algorithm: result.record.algorithm,
        digest: result.record.digest,
        signerHash160: result.record.signerHash160!,
        signature: result.record.signature!,
        label: result.record.label,
      }),
    );
    expect(reEmitted).toBe(foreign.script);
  });

  it("leaves v1 records unsigned rather than inventing a signer", () => {
    for (const fixture of FIXTURES.filter((f) => f.version === 1)) {
      const result = decodeHashMarkScript(hexToBytes(fixture.script)!);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.record.signerHash160).toBeUndefined();
      expect(result.record.signature).toBeUndefined();
    }
  });

  it("rebuilds the exact statement the v2 signature covers", () => {
    const signed = FIXTURES.find((f) => f.version === 2)!;
    const result = decodeHashMarkScript(hexToBytes(signed.script)!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pinned in full. An independent verifier must produce this byte for byte
    // or the signature will not check out, so the string itself is the
    // interoperability contract — not just the fact that one was built.
    expect(
      canonicalAttestationMessage({
        genesisHash: RADIANT_MAINNET.genesisHash,
        signerHash160: result.record.signerHash160!,
        algorithmId: result.record.algorithmId,
        digest: result.record.digest,
        ...(result.record.label === undefined
          ? {}
          : { label: result.record.label }),
      }),
    ).toBe(
      '{"v":"HashMark/v2",' +
        '"network":"0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4",' +
        '"signerHash160":"26ba056431ec69cf27eabeaab250d99ddbd895d2",' +
        '"algorithmId":"01",' +
        '"digest":"e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e"}',
    );
  });

  it("records the same file twice, under different versions", () => {
    // A real property of this set, and a useful one: a digest can carry more
    // than one mark, so a verifier must return a list rather than a single hit.
    const shared = FIXTURES.filter(
      (f) =>
        f.digest ===
        "e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e",
    );
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((f) => f.version))).toEqual(new Set([1, 2]));
    // The unsigned one came first; the attested one is the later claim.
    expect(shared[0]!.blockTime).toBeLessThan(shared[1]!.blockTime);
  });

  it("survives every single-byte corruption without ever mis-decoding", () => {
    // The strongest use for these fixtures: real records, mutated one byte at a
    // time. Every mutation must either fail to decode, or decode to something
    // demonstrably different — a corrupted byte may change what is read, but it
    // must never be silently ignored and yield the original record.
    for (const fixture of FIXTURES) {
      const original = hexToBytes(fixture.script)!;
      const baseline = decodeHashMarkScript(original);
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) continue;

      // Compared as a whole rather than field by field: an earlier version of
      // this test checked a hand-picked set of fields and missed a mutation to
      // the signature's header byte, which changes the record without changing
      // any of them.
      const canonical = JSON.stringify(baseline.record);

      for (let i = 0; i < original.length; i++) {
        const mutated = Uint8Array.from(original);
        mutated[i] = (mutated[i]! + 1) & 0xff;

        const result = decodeHashMarkScript(mutated);
        if (!result.ok) continue;

        expect(
          JSON.stringify(result.record),
          `byte ${i} of ${fixture.txid} was corrupted but decoded identically`,
        ).not.toBe(canonical);
      }
    }
  });

  it("never lets a truncation pass as the original record", () => {
    // Most truncations simply fail. One does not, and it is worth being exact
    // about: cutting a labelled record at the label boundary leaves a
    // well-formed *unlabelled* record, because the label is optional. That is
    // the format behaving as specified, not a decoder flaw — so the invariant
    // is the same one the corruption test uses. A truncation may decode, but it
    // must never decode to the record it was cut from.
    //
    // Stripping a label this way does not get an attacker anything: the label
    // is inside the signed statement, so the shortened record produces a
    // different statement and its signature stops verifying. That half is
    // asserted in the application, where secp256k1 lives.
    for (const fixture of FIXTURES) {
      const original = hexToBytes(fixture.script)!;
      const baseline = JSON.stringify(decodeHashMarkScript(original));

      for (let cut = 1; cut < original.length; cut++) {
        const result = decodeHashMarkScript(original.subarray(0, cut));
        if (!result.ok) continue;
        expect(
          JSON.stringify(result),
          `${fixture.txid} truncated to ${cut} bytes decoded as the original`,
        ).not.toBe(baseline);
      }
    }
  });
});
