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
  canonicalAttestationMessage,
  decodeHashMarkScript,
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
  readonly signerHash160?: string;
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

  it("reads the committed signer of the v2 record", () => {
    const signed = FIXTURES.find((f) => f.version === 2)!;
    const result = decodeHashMarkScript(hexToBytes(signed.script)!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.signerHash160).toBe(signed.signerHash160);
    // 65 bytes: header || r || s.
    expect(result.record.signature).toHaveLength(130);
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

  it("never accepts a truncation of a real record", () => {
    for (const fixture of FIXTURES) {
      const original = hexToBytes(fixture.script)!;
      for (let cut = 1; cut < original.length; cut++) {
        const result = decodeHashMarkScript(original.subarray(0, cut));
        expect(
          result.ok,
          `${fixture.txid} truncated to ${cut} bytes must not decode`,
        ).toBe(false);
      }
    }
  });
});
