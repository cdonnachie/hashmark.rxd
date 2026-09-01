# HashMark v2 — signed attestations

A v2 record carries a signature over the statement it makes, so the party making
the claim is explicit rather than inferred from whoever paid the fee.

> **Status: implemented. Rationale, not specification.**
>
> The normative definition of v2 — byte layout, field rules, canonical
> statement, verification algorithm, conformance checklist — lives in
> [`HASHMARK_PROTOCOL.md`](../HASHMARK_PROTOCOL.md), alongside v1. Implement
> from that.
>
> This document is the reasoning: the attacks that shaped the design, the
> alternatives weighed and rejected, and the trade-offs taken. It is worth
> reading before changing v2, and unnecessary for implementing it. Where the two
> disagree, the protocol document wins.

---

## 1. Why not infer the signer from the inputs

A v1 record contains no identity, but its funding transaction is signed, so a
signer can be inferred from `vin[].scriptSig`. Reviewed properly, that inference
needs all of the following to be sound:

- a lookup of each **previous output**, to confirm it is really P2PKH and that
  `hash160(pubkey)` matches the hash it pays to — two pushes shaped like a
  signature and a pubkey can occur inside a P2SH or covenant spend, and reading
  them as a signer would report an unrelated key;
- a **sighash check**, because `SIGHASH_NONE` or `SIGHASH_SINGLE` does not
  commit to the HashMark output at all — a key can sign such an input without
  authorizing the statement;
- an **"unidentified inputs"** count for everything that fails those tests;
- and caveats for HD wallets (one person, many addresses) and custodial or
  shared funding (many people, one key).

After all of it, the result is still only: *this transaction contains an input
authorized by that key*. The key never made a statement about the file. It paid
a fee.

Nothing is live but a handful of test marks, so there is no compatibility cost
to spending the version byte now. A key that deliberately signs the statement is
both stronger evidence and less code.

## 2. Record layout

```
OP_RETURN
  <push 8>   "HASHMARK"
  <push 2>   version(0x02) ‖ algorithmId
  <push N>   digest, N fixed by algorithmId
  <push 20>  signerHash160 — the committed signer (§2.1)
  <push 65>  compact recoverable signature over the canonical message (§3)
  <push L>   label, OPTIONAL, 1..maxLabelBytes(digest length)  (§2.2)
```

Field order is unchanged for the first three pushes, so a v1 reader that checks
the version byte rejects a v2 record cleanly instead of misreading it.

### 2.1 The committed signer, and why recovery alone is worthless

The signature is **compact recoverable** — the 65-byte form Bitcoin-style
message signing produces, one header byte plus `r` and `s`. Recovery yields a
public key, so the key itself need not be stored. What must be stored is a
**commitment to which key is being claimed**.

Recovering a key from a signature and then verifying the signature against that
recovered key is circular, and it is not a subtle failure — it is total. For any
chosen point `R` and scalar `s`, recovery computes

```
Q = r⁻¹(sR − zG)          r = R.x,  z = the signed message hash
```

and verification of `(r, s)` against that `Q` computes

```
u₁G + u₂Q = (z/s)G + (r/s)·r⁻¹(sR − zG) = R      so  P.x = r  holds
```

by construction. An attacker picks `R` and `s` freely, derives `Q`, and has a
signature that verifies under a key **whose private key nobody needs to know**.

The boundary is worth stating precisely, because it is why this is easy to miss:

- An attacker **cannot** impersonate a *known* address this way. That would mean
  forging a signature under a given public key for a given message, which is the
  ECDSA unforgeability assumption.
- An attacker **can** emit records that display an arbitrary signer that nobody
  controls — which is enough to make "signed by X" a sentence with no meaning,
  and enough to flood a digest with plausible-looking rival attestations.

Bitcoin-style message verification never has this problem because it *starts*
from an expected address and checks that the recovered key hashes to it.
`verifyBitcoinStyleSignedMessage` in
[`signmessage.ts`](../src/lib/radiant/signmessage.ts) does exactly that. A
record read off the chain has no expected address to start from, so v2 puts one
in the record and inside the signed message:

- **`signerHash160` in the record** — 20 bytes, the same hash160 a P2PKH address
  encodes. Verification requires `hash160(recoveredPubkey) == signerHash160`.
- **`signerHash160` in the signed message** (§3) — so the commitment is itself
  signed. Without this the attacker simply writes whatever hash the recovered
  key produces. With it, changing the committed hash changes the message,
  changes `z`, and changes the recovered `Q`: a forger needs a fixed point of a
  160-bit random function, or a target preimage of hash160 to impersonate a
  specific signer. Neither is reachable.

Storing the 33-byte public key instead would cost 13 more bytes and fix nothing
on its own — an uncommitted key in the record is just as freely chosen. The
commitment inside the message is what carries the security, and the hash is the
cheaper way to carry it.

### 2.2 Size

The design ceiling is 223 bytes (`MAX_SCRIPT_BYTES`), so a mark relays even on a
node configured to the Bitcoin-style `MAX_OP_RETURN_RELAY` rather than Radiant's
1024-byte default.

```
OP_RETURN                          1
magic               push 8  + 1 =  9
header              push 2  + 1 =  3
digest         push N(=32) + 1 = 33
signerHash160      push 20  + 1 = 21
signature          push 65  + 1 = 66
                                 ---
                                  133 before the label
label  88 bytes + 2 (PUSHDATA1) =  90  →  223 exactly
```

**The label budget is derived, never assumed.** The figure above holds only for
a 32-byte digest; a longer one must come out of the label, not out of the relay
margin. Derive it from **encoded** push sizes rather than assuming a one-byte
prefix, which only holds through 75 bytes:

```ts
encodedPushSize(n) =
  n <= 75    ? 1 + n :
  n <= 255   ? 2 + n :   // OP_PUSHDATA1
  n <= 65535 ? 3 + n :   // OP_PUSHDATA2
               5 + n     // OP_PUSHDATA4

scriptSize =
    1                              // OP_RETURN
  + encodedPushSize(8)             // magic
  + encodedPushSize(2)             // version + algorithm id
  + encodedPushSize(digestLength)
  + encodedPushSize(20)            // signerHash160
  + encodedPushSize(65)            // signature
  + (labelLength === 0 ? 0 : encodedPushSize(labelLength))
```

The label term is conditional because an absent label is **no push**, not a
zero-length one — `prepareLabel` refuses an empty label rather than encoding an
empty push, and the canonical message omits the key entirely (§3). This does not
move the sha256 maximum of 88 bytes; it makes the figure right for the
unlabelled records that most marks will be.

`maxLabelBytes` is then the largest `labelLength` for which `scriptSize <=
MAX_SCRIPT_BYTES`. The same minimal-push rules `encodePush` in
[`script.ts`](../packages/protocol/src/script.ts) already enforces.

- sha256 (id `0x01`, 32 bytes) → **88 bytes**, down from v1's 128.
- a hypothetical 64-byte digest → 56 bytes, automatically.
- a digest of 76 bytes or more would cross into `OP_PUSHDATA1` for the digest
  push too, which the formula above absorbs and a hardcoded `1 + digestLength`
  would silently get wrong.

v2 currently defines only algorithm id `0x01`. Computing the cap rather than
fixing it means adding an algorithm never silently pushes a record over the
relay limit — the label shrinks instead, visibly, at encode time.

## 3. The canonical message

The signature covers a domain-separated, deterministic **single-line** string:
canonical JSON, fixed key order, no insignificant whitespace.

```json
{"v":"HashMark/v2","network":"<genesis hash per 3.2>","signerHash160":"<40 hex>","algorithmId":"<2 hex>","digest":"<hex>","label":"<canonical label>"}
```

- Key order is fixed exactly as above and is part of the format.
- No whitespace between tokens, no trailing newline.
- `label` is **omitted entirely** when there is none — not included as `""`. A
  record with no label and a record with an empty label must not produce the
  same message, and an empty label is not encodable anyway.
- Escaping is fixed: `"` becomes `\"` and `\` becomes `\\`; every
  other character is emitted as raw UTF-8, never as a `\uXXXX` escape.
  Control characters cannot occur — the label rules reject them and every other
  field is hex.
- The label is NFC-normalized by the encoder before it is signed or written.

### 3.0 Why one line, not five

An earlier draft used a five-line message joined with newlines. **Photonic
cannot sign it.** `assertSignableMessage` in `packages/lib/src/sign.ts` throws
on any character below `0x20`, and a newline is `0x0A`:

```ts
if (hasControlChars(message)) {
  throw new Error("signMessage: message contains control characters");
}
```

That is a deliberate safety rule in the wallet, not an oversight, and other
wallets are likely to carry the same one. A single-line form signs on the
deployed wallet today and needs no upstream change.

Canonical JSON also closes the label-injection surface *structurally* rather
than by blacklist: a label cannot fabricate a field, because quotes and
backslashes are escaped and there are no line breaks to forge. The §3.1 rules
still apply — they defend the wallet's *rendering*, which escaping does not fix
— but the message format no longer depends on them for its integrity.

Readability is the cost. Photonic renders the message in a `<Code>` block with
`whiteSpace="pre-wrap"` and `wordBreak="break-all"`, so a ~250-character JSON
line wraps and stays legible, but it is plainly less pleasant than five labelled
lines. That is the price of not requiring a wallet release before v2 can ship.

A verifier rebuilds this JSON from **the record's fields plus the verified
network context in which the transaction was found** — not from the record alone. The
genesis hash is not in the record; it is a property of the chain the transaction
was fetched from. The distinction matters when a receipt or a raw transaction is
carried between networks: the same record bytes on a different chain produce a
different message, and the signature will not verify. That is the intended
behaviour, and it is why the network belongs in the message.

Rules:

- **`HashMark/v2` first.** Domain separation: a signature obtained for another
  purpose must never validate as a HashMark attestation, and an attestation must
  never be replayable as a login or a payment authorization.
- **Genesis hash, not the network name.** A string label can be claimed; the
  genesis hash is the chain. Receipts already follow this rule.
- **The committed signer is signed.** `signerHash160` is the same 20 bytes the
  record carries, as 40 lowercase hex. This line is what makes the signer claim
  mean anything at all (§2.1); a v2 message without it is unverifiable in the
  strict sense, however well-formed it looks.
- **The algorithm id, not its name.** The record carries the byte `0x01`; names
  acquire aliases and change presentation (`sha256`, `SHA-256`, `sha-256`) and a
  signature must not depend on which spelling was in fashion. The signed value
  is the record byte, rendered as two lowercase hex digits. A wallet or
  interface may *display* `SHA-256 (id 01)`; only the id is signed.
- **The label is signed**, so a label swapped after signing invalidates the
  signature.

### 3.1 The label must not be able to forge message lines

The label is user-supplied text placed inside a message a **wallet renders for a
human to approve**. A label containing a newline can fabricate lines that look
like fields:

```
label:Invoice
network:radiant-testnet
digest:0000…
```

The signature over that string is perfectly valid; the display is a lie. Bidi
overrides can reorder rendered text without any newline at all.

Today `hasControlChars` rejects only `< 0x20` and `0x7f`. Before v2 it must also
reject:

| Rejected | Why |
| --- | --- |
| `\r`, `\n`, `\0` | fabricate or truncate message lines |
| C0 `0x00–0x1F`, DEL `0x7F` | already rejected; keep |
| C1 `0x80–0x9F` | terminal and legacy renderers act on these |
| U+2028, U+2029 | Unicode line and paragraph separators — real line breaks |
| U+200E, U+200F, U+202A–202E, U+2066–2069 | bidi marks, overrides and isolates: reorder rendered text |
| Invalid UTF-8 | already rejected by strict decoding; keep |
| Leading or trailing whitespace | trims to a different string than was displayed |

Leading and trailing whitespace is **trimmed before validation**, not rejected,
so a stray space does not fail a mark. Everything else is a hard rejection at
encode time and a `INVALID` decode result on read.

**For v1, the same rules apply to display but not to validity.** A v1 label is
not signed and not part of any claim, so an unsafe one cannot misrepresent a
statement — it can only misrepresent itself on screen. Invalidating existing v1
records over their labels would destroy timestamp evidence to fix a rendering
problem, which is the wrong trade in both directions.

So the v1 decoder:

- decodes the digest, version and algorithm normally, and the record stays
  **valid**;
- checks the label against the table above and, on failure, **withholds it**
  rather than rejecting the record — the raw bytes stay available to a caller
  that explicitly asks for them;
- reports the reason, so the interface can say *"Label hidden: it contains
  formatting that could misrepresent it"* instead of silently dropping a field
  the chain contains.

The **encoder rejects unsafe labels for both versions**. Nothing should be able
to create one; only already-published v1 records need tolerating.

Suggested decode shape, so the two cases stay distinguishable:

```ts
{ label?: string; labelWithheld?: "CONTROL_CHARS" | "BIDI" | "NON_CANONICAL" }
```

An escaped-JSON canonical form would remove the injection surface structurally,
at the cost of a message no human can read on a wallet screen. Given the
constraints above, the readable form is the better trade — but only with them.

**Canonicalization runs one way.** Creation canonicalizes before signing;
verification never modifies record content, it rejects non-canonical content.

At creation, in order: trim, NFC-normalize, validate against the table above,
**show the user the final canonical label**, then sign and encode exactly that
value.

At verification, decode the label from the on-chain bytes and reject the record
unless it is already canonical:

```ts
label === label.trim() && label === label.normalize("NFC")
```

A decoder that silently trims or normalizes would verify a signature over a
string the chain does not contain — reinterpreting a record instead of checking
it. **In v2**, non-canonical label bytes make the record `INVALID`, not
repairable: the label is part of the signed statement, so a label that is not
what was signed means the statement is not what it claims.

### 3.2 Genesis hash representation

`network:` uses the genesis hash in **RPC/display byte order** — the form
`server.features.genesis_hash` returns, explorers print and receipts already
carry — as 64 lowercase hex characters. Not internal serialized order.

Blockchain implementations routinely reverse hash byte order between internal
and displayed forms, so "the genesis hash in lowercase hex" names two different
strings. The signed value is fixed here:

| Network | value signed on the `network:` line |
| --- | --- |
| `radiant-mainnet` | `0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4` |
| `radiant-testnet` | not yet established — see below |

`RADIANT_TESTNET.genesisHash` is deliberately empty in
[`receipt.ts`](../packages/protocol/src/receipt.ts): no testnet node has been
connected to, and inventing the constant would defeat the check it exists for.
**A v2 attestation cannot be produced or verified on a network whose genesis
hash is unknown**, and the encoder must refuse rather than sign an empty
`network:` line. Populate it from `server.features.genesis_hash` before enabling
testnet.

### 3.3 Signature format, exactly

Independently implementable, matching
[`signmessage.ts`](../src/lib/radiant/signmessage.ts):

```
byte  0        header
bytes 1..32    r, big-endian, 32 bytes, zero-padded
bytes 33..64   s, big-endian, 32 bytes, zero-padded
               65 bytes total
```

- **Prefix:** `"Bitcoin Signed Message:\n"` — Radiant kept Bitcoin's, confirmed
  against real Photonic signatures.
- **Digest signed:** `sha256(sha256( CompactSize(len(prefix)) ‖ prefix ‖
  CompactSize(len(message)) ‖ message ))`, all UTF-8 bytes. Double SHA-256, and
  both lengths are Bitcoin CompactSize (Bitcoin varint), not fixed-width.
- **Header byte:** `27 + recoveryId`, plus `4` when the public key is
  compressed. Valid range `27..34`. `recoveryId = (header - 27) & 3`;
  `compressed = header >= 31`. A header outside `27..34` is invalid.
- **Recovery:** recover the public key from `(r, s, recoveryId)` over the digest
  above, serialize it in the form the header declares, then
  `hash160 = ripemd160(sha256(pubkey))`.
- **Range checks.** Reject unless `1 <= r < n` and `1 <= s <= n/2`, where `n`
  is the secp256k1 group order.
- **Low-S is mandatory**, and its effect is narrower than it sounds. Low-S
  removes the standard `s` versus `n − s` malleability and gives verifiers one
  accepted form for a particular ECDSA signature. It does **not** mean every
  signature of the same message by the same key has identical bytes: ECDSA
  picks a nonce, and a different nonce yields a different valid signature.
  HashMark therefore identifies an attestation by its canonical statement and
  recovered signer, never by the signature bytes.
- **High-S at creation: settled — reject, do not normalize.** Photonic signs
  through radiantjs `Message.sign` → `ECDSA.signWithCalcI` → `_findSignature`,
  which applies `ECDSA.toLowS(s)` unconditionally before returning. It cannot
  emit a high-S signature. So creation rejects high-S rather than carrying
  normalization code for a branch the only supported wallet never takes, and
  verification rejects it as non-canonical whatever produced it.

  If normalization is ever needed for another wallet, the rule is `s := n − s`
  **and** flip the recovery id's low bit (`recid ^= 1`). Normalizing without
  adjusting the recovery id is the easy mistake, and it yields a signature that
  recovers to the wrong key.

- **Signatures are deterministic in practice, and the protocol still must not
  assume it.** radiantjs derives `k` per RFC 6979 (`deterministicK`), so the
  same key and message produce the same bytes on every attempt. `signRandomK`
  exists but `Message.sign` does not use it. This is convenient for testing and
  irrelevant to verification: §3.3's rule stands, an attestation is identified
  by its canonical statement and recovered signer, never by signature bytes.

  (Photonic's own `packages/lib/src/sign.ts` header comment states the opposite
  — "Signing is NON-deterministic (random k)". The code disagrees with the
  comment; worth a one-line fix upstream.)

**Creation procedure**, in order, before any transaction is built:

1. Photonic supplies the signing address (from the connect step).
2. Decode that address to its 20-byte hash160 — this is `signerHash160`.
3. Build the canonical message including `signerHash160` (§3).
4. Ask Photonic to sign that message.
5. Recover the public key from the returned signature.
6. **Confirm `hash160(recoveredPubkey) === signerHash160`.** A mismatch means the
   wallet signed something other than what was asked, or returned a signature
   from a different key; nothing may be broadcast.
7. Store both `signerHash160` and the signature in the record.

Step 6 protects records made through this site. It cannot protect the protocol —
anyone can hand-craft and broadcast a record — which is why the commitment is in
the signed message rather than only in this check.

### 3.4 What the signature does not bind

The signature covers the statement, not the transaction. A published v2 record
can be copied and broadcast again by anyone. That produces another copy of the
same signed statement by the same key: it cannot backdate anything, cannot alter
the digest or label without invalidating the signature, and cannot be attributed
to a different key. Copies are noise, not forgery.

Binding the attestation to a transaction would require a separate canonical
transaction-commitment scheme that excludes the attestation signature — the same
principle by which a sighash omits or transforms fields. That is possible, not
impossible. It adds a second canonicalization to specify, implement and keep in
step, and it addresses no meaningful v2 threat, so the signature intentionally
covers only the HashMark statement.

## 4. Wallet flow — three separate operations

An earlier draft folded the attestation into the connect challenge to keep the
round trips at two. **Do not do that.** The connect challenge
(`radiant:wallet-connect:v1:<nonce>:<label>`) carries authorization meaning:
replay protection through its nonce, origin binding, session establishment, and
a shape Photonic recognizes and badges as a *connection* rather than a message
signature. Overloading it with a HashMark statement blurs all of those, and
saving one interaction does not pay for weakening what an approval means.

Three distinct operations, each with its own approval:

```
1. connect          sign-request, connect challenge      authorize this site
2. attest           sign-request, canonical message (§3) sign the statement
3. sign & broadcast psbt-sign-request, broadcast: true   pay and publish
```

- **Already connected:** steps 2 and 3 — two trips, the same as today.
- **New connection:** three trips. Unavoidable unless Photonic adds a combined
  request type that keeps the two meanings distinct.

The connection is remembered for `IDENTITY_TTL_MS` (12 hours), so the
three-approval case is a first visit, not the common path. Step 2 must happen per
mark regardless, because the signature covers that file's digest.

Step 2 is a genuine improvement in consent: Photonic renders the challenge it is
asked to sign, verbatim, in a `<Code>` block. The user sees the digest and label
they are attesting to rather than an opaque nonce. §3.1 exists because that
screen is only as trustworthy as the text allowed into it.

**Expect an "Unrecognized" warning on that screen.** Photonic badges a challenge
matching `/^[a-z0-9.-]+:wallet-connect:v\d+:/i` as *"Recognized connect"* in
green; anything else gets an orange *"Unrecognized"* badge and a warning:

> **Not a standard connect request** — Only sign if you understand exactly what
> you are approving.

A v2 attestation is deliberately not a connect request, so it will carry that
warning. Two things follow:

- **Do not reshape the message to match the connect pattern.** Making an
  attestation impersonate a connect request to earn a green badge is precisely
  the conflation §4 exists to prevent, and it would mislead the user about what
  they are approving.
- **The honest fix is upstream.** Photonic could recognize a second shape —
  a signed *statement* rather than a connection — and badge it accordingly. That
  is a small, general improvement to the wallet, not a HashMark-specific hack,
  and it would benefit any application that asks for a structured message
  signature. Until then, the warning is accurate: this is not a standard connect
  request, and the user should read what they are signing.

HashMark's own create screen should say what is about to appear, so the warning
is expected rather than alarming.

## 5. Verification and result states

Given a decoded v2 record, the transaction, and the network it was fetched from:

1. Read `signerHash160` from the record — 20 bytes exactly.
2. Rebuild the canonical message from the record's fields, including that
   committed hash, and the verified network context (§3). Never from anything a
   caller supplied.
3. Check the signature encoding: 65 bytes, header `27..34`, ranges and low-S
   (§3.3).
4. Recover the public key over `magicHash(message)`.
5. **Require `hash160(recoveredPubkey) === signerHash160`.** This comparison is
   the verification. Skipping it and simply displaying the recovered key would
   accept any signature at all (§2.1).
6. `signer = base58check(signerHash160)` — the address shown, encoded from the
   committed hash, not from the recovered key.

**Compare addresses decoded, never as strings.** Wherever an address is matched
— Photonic's returned address against the commitment at creation, a receipt's
`expectedSigner` against the record — decode both to `(version byte, hash160)`
and compare those. Base58 string equality would break on any alternate
representation Radiant might later accept, and would compare presentation rather
than identity. The record's own `signerHash160` is already the canonical form,
so every comparison reduces to 20 bytes plus a version-byte check against the
network's expected P2PKH version.

All local computation over bytes already fetched. No prevout lookups, no extra
round trips, no index.

**Four distinct outcomes, kept distinct in the API and the interface:**

| State | Meaning |
| --- | --- |
| **Malformed record** | Encoding violates the rules of a recognized version — wrong push count, bad digest length, non-minimal push, non-canonical or rejected label |
| **Unsupported version** | Correct HashMark magic, version this reader does not know |
| **Invalid signature** | Recognized v2 record, decoded cleanly, signature verification failed |
| **Valid record** | Structure and the applicable signature both verified |

Two boundaries carry weight:

- **Unsupported is not malformed.** A future v3 record is not corrupt; it is
  newer than the reader. Old software calling it malformed would make every
  future version look like damage, and would discourage anyone from shipping
  one. The existing `UNKNOWN_VERSION` decode reason already draws this line and
  the interface must preserve it: *"a newer kind of HashMark record — this
  verifier cannot read it"*.
- **Invalid signature is not malformed either.** The record decoded fine; its
  *claim* did not hold up. It must never be shown as a valid HashMark, but the
  distinction tells a corrupt or hostile record apart from one whose signature
  failed, which is what someone debugging actually needs to know.

A v1 record has no signature and so can only be malformed, unsupported (to a
reader older than v1) or valid.

**Where each check lives.** `decodeHashMarkScript` stays pure and
dependency-free — it has no notion of a network, so it cannot verify a
signature. It returns the record with its raw signature bytes. A separate
`verifyAttestation(record, genesisHash)` performs §5.1–4. Keeping the split
means `@hashmark/protocol` remains usable by a verifier that only wants to read
records.

## 6. What v2 proves, precisely

- **Proves:** the holder of the key committed as `signerHash160` deliberately
  signed this exact statement — this digest, this label, this signer, on this
  chain. The commitment is what makes this a claim rather than a tautology
  (§2.1).
- **Does not prove:** who that person is, that they authored the file, that they
  had any right to mark it, or that a key seen twice belongs to one person.

**Anyone may attest anything.** Replacing both the signature and the committed
signer produces a perfectly valid attestation from a different key — that is
allowed and expected. v2 stops an attacker claiming *someone else's* signer; it
does not, and should not, stop them making their own statement about a file.
Distinguishing "a valid attestation" from "the attestation you were expecting"
is the receipt's job (§7), never the chain's.

The interface wording follows. Not "the same key funded these marks" but **both
records were signed by the same key**. A repeated key is reassuring only to a
reader who already recognizes it, so state it as a fact and never dress it as a
verdict.

Authenticity always requires an anchor the reader brought with them: a key they
already knew, a receipt from a channel they trust, a link from the publisher's
own site. The chain supplies integrity, an upper-bound timestamp, and a signer.
It never supplies trust.

### 6.1 A stable signer is a permanent public link

The property that makes v2 useful is exactly the property that costs privacy: a
signer is stable, so **anyone can find every HashMark signed by the same key and
correlate them** — to each other, and to whatever else that address has done on
chain. Permanently, and without asking.

v1 was never private either — the funding address is on chain and correlatable
by anyone reading the inputs. What v2 changes is that the linkage becomes
deliberate, stable and easy: no heuristics, just a signer field to group by.

For a business or a publisher this is the point: a recognizable key is the whole
value. For personal use it may not be wanted, and the create screen must say so
before the signature is made, not after:

> This signature publicly links this HashMark to your signing address, and to
> every other HashMark signed by the same key — permanently.

Offer the mitigation in the same breath: **use a dedicated wallet for HashMark**
if you do not want your marks tied to your main address. This belongs on the
privacy page too, beside the existing note about what a fingerprint can give
away — it is the same category of permanent, irreversible disclosure.

## 7. Receipt

One optional field. `version` stays 1: `validateReceipt` ignores unknown keys,
so an older verifier reading a newer receipt skips the field rather than
refusing the receipt.

```jsonc
{
  "format": "hashmark-receipt",
  "version": 1,
  // …existing fields…
  "expectedSigner": "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i"   // optional
}
```

Named `expectedSigner`, not `issuer`: the receipt says who the reader should
*expect*, and the chain decides whether that expectation is met.

- Parse-time validation is only that it is a well-formed Radiant address.
- On verification it is decoded to `(version, hash160)` and compared against the
  record's committed `signerHash160` — bytes, not base58 strings (§5) — and
  **the chain wins**, the rule already applied to `digest` and `outputIndex`. A
  mismatch is a disagreement to report, never grounds to reject the record.
- Absent is not a failure. A receipt for a v1 mark has no signer to expect.

Result wording: **"Expected signer found"**, or **"The receipt expects a
different signer than the chain records"**. Never "the receipt is trusted" —
anyone can write a receipt.

## 8. Interface wording

The rule is not a banned word list. `verify` is a word this application has
earned: it verifies digests, transactions, signatures and confirmations, and the
codebase is right to say so (`VerifiedMark`, `verifyTransaction`, `/verify`).

**Verified always takes an object.** State what was verified:

```
File digest verified          the bytes hash to the recorded digest
Transaction verified          fetched from a node and re-decoded
Signature verified            the record was signed by <address>
Receipt agrees with the chain
Confirmed                     448 confirmations
```

**Never** an identity conclusion the chain cannot support: *authentic file*,
*verified creator*, *official publisher*, *owner*, *trusted signer*.

**No WAVE name beside an attestation.** Not even labelled "now". A name shown
next to a historical record will be read as the identity that made it, which is
exactly the transferred-name confusion v2 exists to prevent — and the label is
the first thing to be forgotten when the result is screenshotted or described to
someone else. Show only:

```
Signed by  14XmXG…vgx1i
```

A current WAVE name may appear on a separate address-information panel, or
beside the *connected wallet* in the create flow, where the claim is genuinely
present-tense and about the reader's own wallet. Never in a verification result.

For several records signed by different keys, equal weight and no ranking:

```
2 records for this file, signed by different keys.
Which one you should rely on depends on whose key you expected —
that is not something the chain can answer.

  31 Aug 2026 06:26 UTC   signed by 14XmXG…vgx1i   448 confirmations
  12 Oct 2026 11:04 UTC   signed by 1Ka9dP…7wq2m    12 confirmations
```

## 9. Migration

- **v1 records stay valid and keep verifying.** The decoder accepts both and
  reports `version`. A confirmed v1 mark is evidence that the recorded digest
  existed no later than its containing block; it carries no signer. Avoid
  calling it "a real timestamp" — the block time is evidence, not an authority,
  and the interface already frames it as an upper bound.
- **The encoder only writes v2.** `PROTOCOL_VERSION` becomes 2.
- **The interface distinguishes without ranking:** a v1 mark shows its timestamp
  with "no signature — this record predates signed attestations", in neutral
  styling. The existing test marks are v1 and must not read as suspect.
- **The §3.1 label rules apply asymmetrically.** The encoder refuses an unsafe
  label at any version. The v2 decoder rejects the record. The v1 decoder keeps
  the record valid and withholds only the label — an existing v1 mark never
  loses its timestamp evidence because of how its label was written.
- **The label cap is version- and algorithm-dependent:** 128 when decoding v1,
  and for v2 whatever `maxLabelBytes(digestLength)` yields — 88 for sha256
  (§2.2). Expose it as a function, not a constant, so the live byte counter in
  the create form stays correct if an algorithm is ever added.
- **Test vectors for both versions** in `packages/protocol/test`, including the
  live mainnet v1 record `345565eb…88892` as a permanent regression fixture, and
  a v2 vector with a known key so the signature path has a golden case.

## 10. Out of scope

**"The signer controlled `craigd.rxd` at that block."** Point-in-time WAVE
resolution needs the name's `mod` history. The index reports the current target
only, and taking its word for a historical one would put an unverified index
claim behind an identity statement — inverting the rule the rest of the
application follows. Doing it honestly means fetching and verifying the chain of
`mod` transactions. Separate project, and until it exists WAVE names play no
part in identity (§8).

**Revocation.** A v2 signer can revoke coherently — a later record signed by the
same key, referencing the original txid — which is only possible *because* the
signer is explicit. Two cautions when it is built:

- A revocation is a later statement, not an unmaking. The file still
  demonstrably existed at the original block. Rendering a revoked record as
  invalid destroys the one property the chain guarantees. "The signer withdrew
  this on <date>" is the honest phrasing.
- It is meaningful only to a reader who already trusts that key (§6).

## 11. QR codes

A QR encoding a link to one exact record:

```
https://hashmark.rxd.zone/verify/345565eb…88892/0
```

About 106 bytes, byte mode, error correction M: a 41x41 symbol, scannable at
roughly 2 cm printed. A shorter path (`/v/{txid}/{n}`) buys margin on smaller
prints.

**What it is good for: retrieval.** It saves typing a 64-character transaction
id and names one *exact* record rather than leaving a reader to choose among
several — the same job as a receipt, in a form that survives being printed.

**Three limits the landing page must state plainly:**

1. **A QR proves nothing by itself.** It is a pointer. Anyone who can alter the
   document can alter the QR beside it and point it at a record of *their* copy.
   Trust comes from the channel it arrived through, never from the code.
2. **A phone scan usually cannot check the file.** Whoever scans a printed code
   is unlikely to have the file on that device. The page can show what the chain
   records; it cannot compare it to anything. It must open in a state that says
   so — not a green tick meaning only "this transaction exists".
3. **It depends on this site existing.** Print the digest and transaction id as
   text beside the code, so the record stays checkable against any Radiant node
   without us.

**Shape.** `/verify/{txid}/{outputIndex}` fetches, decodes and shows the record,
with the drop zone present and the outstanding check explicit:

```
Transaction verified                      read from the chain
Signature verified — 14XmXG…vgx1i         signed this statement
File not checked                          drop the file to compare
```

Offer the download as a bundle: the QR image and the receipt JSON are the same
claim in two encodings, and a publisher shipping one usually wants both.

With v2 the QR gets materially better. It points at a record that names its own
signer, so a reader who already knows the publisher's key can complete the trust
chain from the code alone — everything except whether their copy of the file
matches, which only they can supply.

## 12. Required tests

Beyond the encode/decode vectors in §9, the signer commitment needs its own
cases. Every one of these is a unit test over fixed bytes — no network.

**Must verify**

- Valid signature whose recovered key hashes to the committed `signerHash160`.
- A receipt whose `expectedSigner` matches the committed signer.

**Must fail verification**

- Valid signature whose recovered key does **not** match the committed signer.
- **A key-substitution attempt** that derives a public key from an arbitrary
  signature and then replaces `signerHash160` with that key's hash. It must fail
  because the replacement changes the signed message. Concretely: pick any
  `signerHash160`, build the message, choose `R` and `s`, derive `Q`, then
  overwrite `signerHash160` with `hash160(Q)` — the overwrite changes `z`, so the
  signature no longer recovers to `Q`. This is the test that would have caught
  the original design, and if it passes the commitment is not being checked.

  Note what this test is *not*: it does not ask the attacker to produce a
  signature that recovers to the hash inside its own message. That is the fixed
  point §2.1 relies on being unreachable, and a test that required it would be a
  test nobody can write.
- `signerHash160` mutated after signing.
- `digest` mutated after signing.
- `label` mutated after signing, including a change that is only a
  normalization difference.
- `network` context changed — the same record bytes verified against a
  different genesis hash.
- `algorithmId` mutated after signing.
- High-S signature (rejected, or normalized then re-verified — whichever rule
  §3.3 settles on).
- Header byte outside `27..34`; `r` or `s` out of range.

**Must verify, but is not the expected signer**

- Signature *and* committed signer both replaced with another key's valid pair.
  This is a legitimate attestation by someone else and must verify as such —
  then be reported as a mismatch against a receipt naming a different
  `expectedSigner`. Conflating "invalid" with "not who you expected" is the
  failure mode this case exists to prevent.

**Golden vectors**

- The live mainnet v1 record `345565eb…88892`, as a permanent regression fixture
  for v1 decoding.
- A v2 record signed by a known test key, with its canonical message written out
  in full in the test file, so an independent implementation can reproduce the
  bytes without reading this repository's code.
