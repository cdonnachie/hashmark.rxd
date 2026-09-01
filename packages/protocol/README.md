# @hashmark/protocol

The HashMark on-chain format: encoder, decoder, canonical attestation statement
and receipt schema. Framework-independent and **zero runtime dependencies**, so
a third party can verify a mark without pulling in a Radiant library, a wallet,
or anything from hashmark.rxd.zone.

Everything here is pure computation over bytes. Nothing in this package opens a
socket, and it holds no keys.

```bash
npm install @hashmark/protocol
```

## What a HashMark is

A file's digest, written to an `OP_RETURN` output on Radiant, so that anyone can
later show the file existed no later than the block that carried it. A **v2**
record additionally carries a signature over the statement it makes, so it can
say *which key* made the mark — not who wrote the file, and not who owns it.

The full byte layout, validation rules, threat model and worked examples are in
[`HASHMARK_PROTOCOL.md`](https://github.com/cdonnachie/hashmark.rxd/blob/main/HASHMARK_PROTOCOL.md).

## Reading a record

```ts
import { decodeHashMarkScript, hexToBytes } from "@hashmark/protocol";

const result = decodeHashMarkScript(hexToBytes(scriptPubKeyHex)!);

if (!result.ok) {
  // NOT_HASHMARK is not an error: most OP_RETURNs belong to other protocols.
  if (result.reason !== "NOT_HASHMARK") console.warn(result.detail);
} else {
  const { version, algorithm, digest, label, signerHash160 } = result.record;
}
```

A record that decodes is **well-formed, not yet believed**. For v2 the signature
still has to be checked, and that needs secp256k1 and the genesis hash of the
chain the transaction came from — neither of which belongs in a dependency-free
package. This package gives you the statement to check against:

```ts
import { canonicalAttestationMessage } from "@hashmark/protocol";

const statement = canonicalAttestationMessage({
  genesisHash,           // of the chain the transaction was FOUND on
  signerHash160: record.signerHash160!,
  algorithmId: record.algorithmId,
  digest: record.digest,
  label: record.label,
});
```

Recover the public key from the 65-byte signature over
`magicHash(statement)`, then require `hash160(recovered) === signerHash160`.
**That comparison is the verification.** Recovering a key and then checking the
signature against that same key proves nothing — for any chosen signature values
there is a key under which they verify. See §2.3.1 of the spec.

## Writing a record

```ts
import { encodeHashMarkScript } from "@hashmark/protocol";

const script = encodeHashMarkScript({
  algorithm: "sha256",
  digest,
  signerHash160,   // the key you are about to commit to
  signature,       // its signature over canonicalAttestationMessage(...)
  label,           // optional
});
```

The signature comes from a wallet; this package never signs. `encodeLegacyV1Script`
writes the older unsigned format, and exists for tooling and test fixtures rather
than for new marks.

## Receipts

A receipt is a pointer that helps someone find a mark. It is **never evidence** —
every value shown to a user must come from the chain.

```ts
import { buildReceipt, parseReceipt, serializeReceipt } from "@hashmark/protocol";
```

`receipt.schema.json` ships with the package for validating them elsewhere.

## Licence

MIT.
