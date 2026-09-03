# HashMark Protocol

A minimal, versioned format for recording a file's cryptographic digest on the
Radiant blockchain, so that anyone can later prove the file existed no later
than the block that confirmed the transaction.

- **Protocol identifier:** `HASHMARK`
- **Version:** 1
- **Status:** stable
- **Chain:** Radiant (RXD) — mainnet genesis
  `0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4`
- **Reference implementation:** [`packages/protocol`](packages/protocol) —
  TypeScript, zero dependencies, 69 tests

This document is written so that a developer with no access to the HashMark
codebase can implement a complete, independent verifier. If anything here is
ambiguous, that is a bug in this document; please report it.

---

**Two record versions exist, and this document specifies both.**

| | v1 | v2 |
| --- | --- | --- |
| Pushes | 3 or 4 | 5 or 6 |
| Says *when* | yes | yes |
| Says *who* | no | yes — a committed signer and a signature over the statement |
| Label cap | 128 bytes | derived; 88 for sha256 |
| Status | valid forever; still verified | what implementations should write |

v1 records are permanent and remain fully valid: a v1 mark is evidence that a
digest existed no later than its block, which is the whole of what v1 ever
claimed. v2 adds an explicit signer, so a mark can also say *who* made it —
without which two marks of the same file are indistinguishable, and the second
one is as valid as the first.

The design rationale for v2, including the attacks that shaped it and the
alternatives rejected, is in
[`docs/HASHMARK_V2_ATTESTATION.md`](docs/HASHMARK_V2_ATTESTATION.md). That
document explains *why*; this one is what an implementer must follow.

## 1. Purpose

A HashMark answers exactly one question:

> Did this exact sequence of bytes exist at or before a given point in time?

It answers that question without revealing the file, by recording only a
cryptographic digest. The blockchain supplies the timestamp: a transaction in a
confirmed block cannot have been created after that block was mined.

### 1.1 What a HashMark does not prove

This section is normative for any user interface built on this protocol.
Implementations **must not** present a HashMark as establishing any of the
following:

| Not proven | Why |
| --- | --- |
| **Authorship** | Anyone can hash a file they did not write and mark it. A mark proves possession of the *bytes*, not creation of them. A v2 signature identifies the key that made the statement, never the author of the file. |
| **Ownership** | The protocol records no identity a reader can resolve to a person. A v2 signer is a key; the transaction's funding address is not evidence of who "owns" anything, and neither is the signer. |
| **Originality** | Two people can mark the same file. The earliest confirmed mark is earliest, not rightful. |
| **The truth of the contents** | A timestamped lie is a timestamped lie. |
| **Legal validity** | Jurisdiction-dependent, and outside the scope of a hash. |
| **That the file existed no *earlier* than the block** | A mark places an upper bound on creation time only. The file may be far older. |

The only supported claim is: *someone knew this digest no later than the
confirmed block containing this transaction.* For a v2 record, one further
claim is supported: *the holder of the committed key signed that statement.*
Both are claims about bytes and keys. Neither is a claim about a person.

## 2. Threat model

### 2.1 Hash collisions

The protocol's guarantee reduces to the collision resistance of the algorithm
named in the record. SHA-256 has no known practical collision attack. If one
were found, an attacker could construct a second file matching an existing
mark, and every SHA-256 mark would become unreliable.

This is why the algorithm is a **field, not an assumption**. A verifier must
read the algorithm id from the record and must reject ids it does not know
(§6), rather than assuming SHA-256. New algorithms are added without a version
bump; see §9.

### 2.2 Preimage limitations

A digest reveals nothing about the file **only if the file has enough entropy**.
For a low-entropy document — a one-line contract from a known template, a
number in a small range — an attacker who can guess candidate files can confirm
a guess by hashing it. Publishing a digest of such a file is not equivalent to
keeping it secret.

Users who need secrecy against a guessing attacker should mark a file that
contains a high-entropy salt.

### 2.3 False ownership and backdating claims

Marking a file you did not create is trivial and undetectable. A verifier must
therefore never render a mark as attribution. Conversely, a mark **cannot** be
backdated: the block timestamp is set by miners and validated by consensus
rules, so a transaction cannot be inserted into an earlier block after the fact.

A v2 signature narrows this but does not close it. It establishes which key made
the statement, so two marks of one file by different parties become
distinguishable — but a key can sign a file it did not author just as easily as
it can pay for one. Attribution still requires the reader to already know whose
key it is (§7.5).

Block timestamps are not perfectly accurate — see §8.

### 2.3.1 Key substitution (v2)

A recoverable signature does not, on its own, identify a signer. For any chosen
point `R` and scalar `s`, key recovery yields a public key `Q` under which that
signature verifies **by construction**, with no private key involved. So a
verifier that recovers a key and then checks the signature against that same
recovered key has checked nothing.

This is why a v2 record commits to its signer as a field *and* covers that
commitment in the signed statement (§5.5, §5.6). Verification is a comparison
against a value fixed before the signature was made, not a value derived from
it. An attacker can still make their own statement about a file with their own
key — that is expected, and is what §7.5 is about — but cannot make a signature
verify as a signer someone else committed to.

### 2.4 Mempool replacement and disappearance

An unconfirmed transaction is **not proof of anything**. It can be evicted,
replaced, or simply never mined. Implementations must distinguish first-seen
time from confirmed block time, and must not present an unconfirmed HashMark as
permanent (§7.4).

### 2.5 Chain reorganizations

A transaction confirmed in a block can be returned to the mempool if that block
is orphaned. A verifier must therefore treat confirmation as a *current*
property, recomputed from the chain tip, never as a stored fact. Records should
carry the block hash, not only the height, so that a reorg is detectable rather
than inferred.

Implementations should require several confirmations before describing a mark
as settled. HashMark's own interface uses: unconfirmed → 1–5 confirmations
("confirming") → 6 or more ("confirmed").

### 2.6 Malicious metadata

The optional label is attacker-controlled text that will be displayed to other
people. It is constrained at the protocol level — length in **bytes**, valid
UTF-8, no control characters (§5.4) — and implementations must additionally
escape it on output. A label must never be rendered as HTML, used as a
filesystem path, or interpolated into a shell command, a SQL query or a URL
without encoding.

### 2.7 Fake receipts

A receipt (§10) is a plain JSON file. Anyone can write one claiming any digest
and any transaction id. A receipt is **never** evidence. It is a pointer whose
claims must be checked against the chain before anything is shown as verified.

### 2.8 Compromised or buggy indexers

Searching the chain by digest requires an index (§11). An index can lie: omit
records, invent them, or return a record that does not match the digest asked
for.

The mitigation is structural: **always re-fetch the referenced transaction and
re-decode the output before presenting a result.** Under that rule a hostile
index can cause a false *negative* (a mark that exists but is not found), which
is a availability problem, but never a false *positive*, which would be a
correctness problem.

### 2.9 Wallet impersonation

A site that asks a user to sign or approve a transaction can be impersonated. A
wallet's approval screen — not the requesting site — is the security boundary.
Implementations must never ask for a seed phrase or private key under any
circumstance, and must show exactly what will be published before requesting
approval.

### 2.10 Network mismatch

A mark made on testnet must never verify as a mainnet proof. Bind records and
receipts to the chain's **genesis hash**, not to a human-readable network name
(§10.3), and check it before trusting a lookup.

## 3. Transaction shape

A HashMark transaction is an ordinary Radiant transaction containing at least
one output whose `scriptPubKey` is a HashMark record.

- The record output carries **0 photons**.
- The record output is conventionally output index **0**, but a verifier
  **must not** assume this — scan all outputs, and address a specific one by
  index when following a receipt.
- Remaining inputs, outputs and change are unconstrained.
- More than one HashMark output in a single transaction is permitted. Each is
  an independent record.

### 3.1 Why a bare `OP_RETURN`

Radiant Core classifies a data-carrier output as `TX_NULL_DATA` — which is both
standard *and* exempt from the dust rule, so a 0-photon output is legal — only
when the script's **first byte is `OP_RETURN` (0x6A)** and the remainder is
push-only (`src/script/standard.cpp`, `Solver()`).

Note a genuine inconsistency in Radiant Core: `CScript::IsUnspendable()`
(`src/script/script.h`) detects only the `OP_FALSE OP_RETURN` form, and
`Solver()`'s comment claims to use that test, but its code does not. An
`OP_FALSE OP_RETURN` script therefore falls through to `TX_NONSTANDARD` and is
**not relayed**. A scan of recent mainnet blocks agrees: every data output
observed is a bare `OP_RETURN`, and none uses `OP_FALSE OP_RETURN`.

HashMark therefore uses a bare `OP_RETURN`. Such an output is unspendable in
practice — `OP_RETURN` aborts script evaluation immediately — but is not
flagged by Core's `IsUnspendable()` pruning helper. This document does not
claim provable unspendability, only that the output cannot be spent.

If a future Radiant release makes `OP_FALSE OP_RETURN` the standard form, that
is a new protocol version, not a silent change to version 1.

### 3.2 Size limits

Radiant Core sums `scriptPubKey.size()` over all `TX_NULL_DATA` outputs and
rejects a transaction whose total exceeds `nMaxDatacarrierBytes`, which
defaults to **1024** (`DEFAULT_DATACARRIER_BYTES`). The same header also
defines `MAX_OP_RETURN_RELAY` = 223, the Bitcoin-style value an operator may
configure down to.

A v1 record is at most **176 bytes** and a v2 record at most **223 bytes**, both
inside the 1024-byte default. v2 is designed to reach exactly 223 so it also
relays on a node configured down to `MAX_OP_RETURN_RELAY`; that ceiling, not the
default, is what the label budget is derived from (§5.4).

## 4. Byte layout

**v1** — 3 pushes, or 4 with a label:

```
OP_RETURN
  <push>  magic       8 bytes    ASCII "HASHMARK"
  <push>  header      2 bytes    version (uint8) ‖ algorithmId (uint8)
  <push>  digest      N bytes    N determined by algorithmId
  <push>  label       1..128     OPTIONAL, UTF-8
```

**v2** — 5 pushes, or 6 with a label:

```
OP_RETURN
  <push>  magic       8 bytes    ASCII "HASHMARK"
  <push>  header      2 bytes    version (uint8) ‖ algorithmId (uint8)
  <push>  digest      N bytes    N determined by algorithmId
  <push>  signer     20 bytes    hash160 of the public key that signed (§5.5)
  <push>  signature  65 bytes    compact recoverable signature (§5.6)
  <push>  label       1..L       OPTIONAL, UTF-8, L derived (§5.4)
```

Fields are **positional**. There are no delimiters, no keys and no padding.

The label sits at push 3 in v1 and push 5 in v2. That is the concrete reason a
decoder must never read an unknown version under a known version's rules: a v1
parser let loose on a v2 record would report a signature as a label.

### 4.1 Push encoding

Every push **must be minimally encoded**: the shortest opcode that can express
its length.

| Length | Encoding |
| --- | --- |
| 1–75 | single length byte `0x01`–`0x4B`, then the data |
| 76–255 | `OP_PUSHDATA1` (`0x4C`), one length byte, then the data |
| 256–520 | `OP_PUSHDATA2` (`0x4D`), two length bytes little-endian, then the data |

A verifier **must reject**:

- `OP_PUSHDATA1` carrying a length ≤ 75, or `OP_PUSHDATA2` carrying a length
  ≤ 255 — these are non-minimal.
- `OP_PUSHDATA4` (`0x4E`).
- `OP_0` (`0x00`), `OP_1NEGATE` (`0x4F`) and `OP_1`–`OP_16` (`0x51`–`0x60`).
  These are push operations in Bitcoin's `IsPushOnly` sense, but accepting them
  would give a one-byte field a second spelling.
- Any non-push opcode.
- Any push extending beyond the end of the script.

The purpose of these rules is that **every record has exactly one valid
serialization**. Two independent encoders given the same inputs must produce
identical bytes, so records can be compared byte-for-byte.

## 5. Field definitions

### 5.1 Magic — 8 bytes

The exact ASCII bytes `48 41 53 48 4D 41 52 4B` (`"HASHMARK"`). Compared as
bytes, never as a decoded string.

A script whose first push is not this is **not a HashMark** and must be skipped
silently (§6). Most `OP_RETURN` outputs on Radiant belong to other protocols.

### 5.2 Header — exactly 2 bytes

| Offset | Field | Type |
| --- | --- | --- |
| 0 | `version` | uint8 |
| 1 | `algorithmId` | uint8 |

Version and algorithm share one push so that neither can be spelled two ways —
a one-byte push could otherwise be written as either `0x01 0x01` or `OP_1`.

A header push of any length other than 2 is a malformed record.

### 5.3 Digest — N bytes

The raw digest bytes. **N is determined by `algorithmId`, never by the push
length.** A verifier reads the expected length from its algorithm registry and
rejects the record if the push length differs. This is what prevents a
truncated digest from being accepted at the wrong width.

| `algorithmId` | Name | Digest length |
| --- | --- | --- |
| `0x01` | `sha256` | 32 bytes |

Ids `0x00` and `0x02`–`0xFF` are unassigned. See §9 for adding one.

When rendered as text — in receipts, APIs and user interfaces — a digest is
**lowercase hexadecimal**, always. Uppercase hex must be rejected rather than
normalized, so that a digest has exactly one accepted spelling.

### 5.4 Label — optional

A short public caption, chosen by the user. The last push of a record, when
present: push 3 in v1, push 5 in v2.

**Maximum length is version-dependent and, in v2, derived rather than fixed.**
v1 allows 128 bytes. v2 spends 87 bytes on the signer and signature, so its
budget is whatever remains of the 223-byte ceiling:

```
maxLabelBytes(digestLength) =
  the largest L for which
    1                                  OP_RETURN
  + encodedPushSize(8)                 magic
  + encodedPushSize(2)                 header
  + encodedPushSize(digestLength)
  + encodedPushSize(20)                signer
  + encodedPushSize(65)                signature
  + (L == 0 ? 0 : encodedPushSize(L))  label
  <= 223

encodedPushSize(n) = n <= 75 ? 1 + n : n <= 255 ? 2 + n : 3 + n
```

For sha256 that is **88 bytes**. An absent label is no push at all, not a
zero-length one, which is why the label term is conditional. Computing the cap
rather than fixing it means registering a longer digest shrinks the label
visibly at encode time instead of silently producing records that stop relaying.

Rules:

- Measured in **UTF-8 bytes, not characters.** A 43-character emoji string is
  172 bytes and exceeds every version's cap.
- Must decode as **strict UTF-8**. Malformed sequences are a malformed record,
  not text with odd characters in it — a decoder must not substitute U+FFFD.
- Must contain **no character that can hide or reorder what is rendered**:

  | Rejected | Why |
  | --- | --- |
  | C0 `0x00-0x1F`, DEL `0x7F` | smuggle line breaks or terminal escapes past a human reviewer |
  | C1 `0x80-0x9F` | terminals and legacy renderers still act on these |
  | U+2028, U+2029 | Unicode line and paragraph separators, which are real line breaks |
  | U+061C, U+200B, U+200E, U+200F, U+202A-202E, U+2066-2069, U+FEFF | bidi marks, overrides and isolates: these reorder rendered text with no line break at all |

  U+200C ZWNJ and U+200D ZWJ are **not** rejected: they are joiners, cannot
  reorder anything, and are load-bearing in Devanagari and emoji sequences.

- Encoders **must trim leading and trailing whitespace and normalize to Unicode
  NFC** before measuring, signing and writing, and must show the user the
  resulting canonical label, because that is what will be published.
- **Canonicalisation runs one way.** A decoder must never trim or normalize a
  label it has read; it rejects or withholds a non-canonical one. A decoder that
  repaired a label would, in v2, be verifying a signature over a string the
  chain does not contain.
- An empty label is not representable. Omit the push entirely rather than
  writing a zero-length one.

**What a decoder does with a label that breaks these rules is
version-dependent**, and the difference is deliberate:

- **v1** — the record stays **valid** and the label is **withheld** from
  display, with a reason. A v1 label is not signed and forms no part of any
  claim, so a dangerous one can misrepresent itself on screen but cannot
  misrepresent a statement. Invalidating the record would discard timestamp
  evidence to fix a rendering problem.
- **v2** — the record is **`INVALID`**. The label is inside the signed
  statement, so a label that is not canonical is not the label that was signed.

The label is **permanently public**. Implementations must warn users of this
before broadcast, and must not place a filename there by default.

### 5.5 Signer — 20 bytes, v2 only

The `hash160` (`RIPEMD160(SHA256(pubkey))`) of the public key that signed this
record: the same 20 bytes a P2PKH address encodes.

This field is a **commitment**, and it is what makes the signature mean
anything. Verification recovers a public key from the signature and requires
`hash160(recovered) == signer`. Without a value fixed in advance to compare
against, recovery is circular and proves nothing (2.3.1).

It is committed twice: here, in the record, and inside the signed statement
(5.6). Both are required. In the record alone, an attacker would simply write
whatever hash their chosen signature recovers to; inside the statement, changing
it changes the message, which changes what the signature recovers to.

The signer need not be, and often is not, the address that funded the
transaction. Separating the party making the statement from whichever UTXOs paid
the fee is deliberate.

### 5.6 Signature — 65 bytes, v2 only

A compact recoverable ECDSA signature over the canonical statement below, in the
form Bitcoin-style message signing produces.

```
byte  0        header
bytes 1..32    r, big-endian, zero-padded to 32
bytes 33..64   s, big-endian, zero-padded to 32
```

- **Header** is `27 + recoveryId`, plus `4` when the public key is compressed;
  valid range `27..34`. `recoveryId = (header - 27) & 3`,
  `compressed = header >= 31`.
- **Ranges**: reject unless `1 <= r < n` and `1 <= s <= n/2`, where `n` is the
  secp256k1 group order.
- **Low-S is mandatory.** It removes the `s` versus `n - s` malleability and
  gives verifiers one accepted form for a given signature. It does **not** make
  signatures unique: a different nonce yields different bytes for the same key
  and message. An attestation is identified by its statement and recovered
  signer, never by these bytes.

#### The canonical statement

The signature covers a single-line, domain-separated JSON string with fixed key
order and no insignificant whitespace:

```json
{"v":"HashMark/v2","network":"<genesis hash>","signerHash160":"<40 hex>","algorithmId":"<2 hex>","digest":"<hex>","label":"<canonical label>"}
```

- `label` is **omitted entirely** when the record has none, never included as an
  empty string.
- Escaping is fixed: a quote becomes `\"` and a backslash becomes `\\`;
  every other character is emitted as raw UTF-8, never as a `\uXXXX` escape.
  Control characters cannot occur, because the label rules reject them and every
  other field is hex.
- `network` is the chain's genesis hash in **RPC/display byte order**, 64
  lowercase hex. For Radiant mainnet that is
  `0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4`. It is
  **not carried by the record**: it is the verified context the transaction was
  found in. The same bytes on another chain therefore make a different statement
  and will not verify there, which is intended. A network whose genesis hash is
  unknown cannot be attested to at all.
- `algorithmId` is the header byte as two lowercase hex digits, never a name.
  Names acquire aliases (`sha256`, `SHA-256`, `sha-256`), and a signature must
  not depend on which spelling was in fashion.

Single-line rather than a more readable multi-line form, because a wallet may
refuse to sign a message containing control characters — a newline is one — and
canonical JSON also removes the label's ability to fabricate a field
structurally rather than by blacklist.

The bytes signed are `magicHash(statement)`:

```
SHA256(SHA256( CompactSize(len(prefix)) || prefix
             || CompactSize(len(statement)) || statement ))
```

with `prefix = "Bitcoin Signed Message:\n"` — Radiant retains Bitcoin's.

## 6. Validation rules

A decoder takes a `scriptPubKey` and returns either a record or a typed
failure. It must **never** return a partial or best-effort result.

Decoding and attestation are **separate steps** with separate outcomes.
Decoding needs only these bytes; verifying a v2 signature additionally needs
secp256k1 and the chain the transaction was found on, which a decoder in a
dependency-free library will not have. A record that decodes is well-formed, not
yet believed.

Decode outcomes:

| Outcome | Meaning | Caller should |
| --- | --- | --- |
| `NOT_HASHMARK` | Not a HashMark output at all. | Skip silently. Not an error. |
| `INVALID` | Claims to be a HashMark; malformed. | Report as malformed. |
| `UNKNOWN_VERSION` | A HashMark of a version this decoder does not implement. | Report the version; do not interpret. It is newer, not broken. |
| `UNKNOWN_ALGORITHM` | Uses a hash algorithm not implemented. | Report the id; do not interpret. |

Attestation outcomes, for a decoded v2 record (§6.3):

| Outcome | Meaning |
| --- | --- |
| valid | The signature recovers to the committed signer. |
| invalid signature | The record decoded cleanly; its claim does not hold. |

Three separations matter, and each has cost someone a wrong answer somewhere:

- `NOT_HASHMARK` from `INVALID` — a block scanner meets thousands of other
  protocols' `OP_RETURN` outputs, and treating them as errors buries real ones.
- `UNKNOWN_VERSION` from `INVALID` — a record from the future is not corrupt.
  Reporting it as malformed would make every later version look like damage and
  discourage anyone from shipping one.
- **invalid signature from `INVALID`** — the bytes were fine; the claim was not.
  An invalid-signature record must never be shown as a valid mark, but calling
  it malformed sends whoever is debugging it after the wrong problem.

### 6.1 Algorithm

```
1.  If the script is empty, or script[0] != 0x6A (OP_RETURN):
        → NOT_HASHMARK
2.  Read all pushes from offset 1 under the minimal-encoding rules of §4.1.
    If any push is malformed or non-minimal:
        → NOT_HASHMARK      (no magic seen yet, so no HashMark claim)
3.  If there are no pushes, or push[0] does not byte-equal "HASHMARK":
        → NOT_HASHMARK

    -- Beyond this point the output claims to be a HashMark, so every
    -- remaining failure is a genuine defect.

4.  If there are fewer than 3 pushes, or push[1] is not exactly 2 bytes:
        → INVALID
        -- The push count depends on the version, which lives in push[1], so
        -- the shape can only be checked once the header has been read.
5.  version := push[1][0];  algorithmId := push[1][1]
6.  If version is not 1 or 2:
        → UNKNOWN_VERSION (report version)
7.  If algorithmId is not in the registry:
        → UNKNOWN_ALGORITHM (report algorithmId)
8.  If length(push[2]) != registry[algorithmId].digestLength:
        → INVALID
9.  Version-specific shape:
        v1: pushes must number 3 or 4;  label is push[3];  cap 128
        v2: pushes must number 5 or 6;  label is push[5];
            cap maxLabelBytes(digestLength)
        Otherwise → INVALID
10. If version == 2:
        a. If length(push[3]) != 20:                → INVALID   (signer)
        b. If length(push[4]) != 65:                → INVALID   (signature)
11. If a label push is present:
        a. If it exceeds the version's cap:         → INVALID
        b. If it is not strict UTF-8:               → INVALID
        c. If it breaks the §5.4 character or canonical rules:
               v1 → keep the record, WITHHOLD the label, report the reason
               v2 → INVALID
12. → record { version, algorithmId, digest, label?, labelWithheld?,
               signer?, signature? }
```

A decoder must not verify the signature here, and must not report a v2 record as
valid on the strength of decoding alone. See §6.3.

Step 7 deliberately precedes step 8. A future version may redefine every field
after the header, so nothing beyond it can be assumed to mean what it means in
version 1. A decoder must never read a version 2 record as version 1.

### 6.2 Robustness requirement

A decoder must be total: for **any** byte sequence, including empty, random,
adversarial or megabytes long, it must return one of the four outcomes and must
not throw, hang, or allocate unboundedly.

### 6.3 Verifying a v2 attestation

Given a decoded v2 record and the genesis hash of the chain the transaction was
**actually found on**:

```
1.  Read the committed signer from the record (20 bytes).
2.  Rebuild the canonical statement (§5.6) from the record's own fields and
    that genesis hash. Never from anything a caller supplied.
3.  Check the signature encoding: 65 bytes, header 27..34, r and s in range,
    s low.                                            Otherwise → invalid
4.  Recover the public key over magicHash(statement).  Failure → invalid
5.  Require hash160(recovered) == committed signer.    Mismatch → invalid
6.  The signer, as an address, is base58check(committed signer) — encoded from
    the record's own bytes, never from the recovered key.
```

**Step 5 is the verification.** Skipping it and displaying the recovered key
would accept any signature at all (§2.3.1). Steps 1 to 5 are local computation
over bytes already in hand: no prevout lookups, no network access, no index.

## 7. Verifying a file

### 7.1 Verifying a file against a mark

```
1. Hash the file locally with the record's algorithm.
2. Compare the digest to the record's digest, as bytes (or as lowercase hex).
3. Fetch the transaction from a Radiant node and confirm the record output
   really is present at the stated index — never rely on an index or a receipt.
4. For a v2 record, verify the attestation (§6.3). A record whose signature does
   not hold must not be presented as a mark at all.
5. Read the confirmation state (§7.4).
```

A mismatch means **this file does not match this mark**. It does not mean the
file is fraudulent, and must not be described that way: the far likelier
explanations are a different version of the document, a re-save that changed
metadata, or a different file entirely.

### 7.2 Finding a mark from a file

Radiant's ElectrumX/RXinDexer servers expose no method to search by arbitrary
data-output content — verified: `blockchain.opreturn.get`,
`blockchain.data.search` and `blockchain.hash.search` are all unknown methods,
and `blockchain.ref.get` indexes Glyph token refs, not data payloads.

Finding a mark from a digest therefore requires an index (§11). Whatever the
index returns must be re-verified per §2.8.

### 7.2.1 Several marks for one file

A digest is not unique, and this is by design: anyone may mark any file, any
number of times. An index returns a list, and an interface must present it as
one.

- Marks by the **same signer** may be said so plainly.
- Marks by **different signers**, or a mixture of signed and unsigned records,
  must be presented with equal weight. An implementation must not rank them,
  and must not describe the earliest as canonical or rightful. Which one matters
  depends on whose key the reader expected, and the chain cannot answer that.
- The timestamp claim is unaffected either way: the earliest confirmed mark is
  still evidence the file existed by then, whoever made it.

### 7.3 Verifying without any index

An index is only needed for *search*. Given a transaction id — from a receipt,
a link, or a note — verification needs nothing but a Radiant node:

```
blockchain.transaction.get(<txid>, true)
  → decode vout[n].scriptPubKey.hex per §6
  → compare digest, read blockhash / confirmations / blocktime
```

This is the property that keeps the protocol independent of any one service,
including HashMark itself. A v2 record adds one step and no dependency: the
signature is verified from the record's own bytes plus the genesis hash of the
chain it was fetched from.

### 7.4 Confirmation states

| State | Condition | How to present it |
| --- | --- | --- |
| Unconfirmed | In the mempool, no block | Show *first-seen* time, clearly not authoritative. Not proof. |
| Confirming | 1–5 confirmations | Show block time; note it can still be reorganized. |
| Confirmed | ≥ 6 confirmations | Show block time as the timestamp. |

Confirmations are computed as `tipHeight - recordHeight + 1` at query time.
Never store a confirmation count; never store "confirmed" as a permanent fact.

### 7.5 What a signer establishes, and what it does not

For a v2 record whose signature verifies:

- **Established**: the holder of the committed key deliberately signed this
  exact statement — this digest, this label, this signer, on this chain.
- **Not established**: who that person is; that they authored the file; that
  they had any right to mark it; or that a key seen twice belongs to one person.

A signer is a value to be **matched against something the reader already knew** —
a key from the publisher's own site, a receipt from a channel they trust. Shown
to a reader with no such expectation, it adds distinguishability, not trust.
Anyone may make their own attestation of any file with their own key, and such a
record is perfectly valid; telling "valid" apart from "the one you expected" is
the reader's job, never the chain's.

Implementations must not describe a mark, or a signer, as *authentic*,
*official*, *verified creator*, *owner* or *trusted*.

### 7.6 Binding a mark to a name

It is tempting to resolve the signer through a naming system — WAVE, or any
other — and report "recorded by whoever owns `company.rxd`". Done naively this
is **unsound**, and the failure is not subtle.

A name resolves to whatever it points at **now**. A mark was made at some past
block. Applying a present-tense lookup to a past event gives a wrong answer in
both directions the moment a name changes hands:

- A genuine mark signed by the previous holder now fails the check, because the
  name resolves elsewhere. A real record is rejected.
- Worse, someone who acquires a lapsed or transferred name can make **new**
  marks that verify as "signed by whoever owns `company.rxd`" — which is true,
  and which a reader will hear as "the company made this". The timestamp is
  honest; the identity inference is not.

Names on Radiant have terms and can expire, so acquiring one after it lapses is
cheap and ordinary, not a theoretical attack.

Two forms are acceptable:

1. **Present tense, and explicit about it.** *"Signed by `14XmXG…vgx1i`, which
   `company.rxd` resolves to right now."* Two facts, separately sourced, neither
   presented as a property of the mark.
2. **Point-in-time resolution.** Establish what the name pointed at **at the
   block that carried the mark**, by fetching and verifying the chain of
   modification transactions that changed its target. Then *"recorded by the
   holder of `company.rxd` at that time"* is a sound statement.

An implementation must not take a name-service index's word for a historical
target. That is an unverified claim standing behind an identity statement, which
is the inversion this protocol avoids everywhere else (§2.8).

Until an implementation does the point-in-time work, a name may be shown as
present-tense context — never beside the mark as though it were part of it.

## 8. Timestamp limitations

The timestamp of a HashMark is the **block time** of the block containing the
transaction. This is not a wall clock:

- A block's timestamp is chosen by the miner and only loosely constrained by
  consensus. It must exceed the median of the previous 11 blocks, and must not
  be too far ahead of network-adjusted time. The practical accuracy is on the
  order of **an hour or two**, not seconds.
- The correct reading is therefore an **upper bound**: the data existed *no
  later than* approximately this time.
- A local clock — the user's, or the server's — is **not** authoritative and
  must never be presented as the mark's time. It may be shown as "submitted at"
  for an unconfirmed transaction, clearly labelled as such.
- Deeper confirmation increases confidence in the block, not the precision of
  its timestamp.

## 9. Versioning policy

- `version` is a single byte in the header. Versions 1 and 2 are both specified
  by this document. Implementations should **write** v2 and must continue to
  **read** v1.
- **A version bump is required** to change the number, order or meaning of
  fields; the magic; the push-encoding rules; or the output form (for example
  moving to `OP_FALSE OP_RETURN`).
- **A version bump is not required** to register a new hash algorithm. The
  algorithm id is a field; an old decoder meeting a new id returns
  `UNKNOWN_ALGORITHM` and stops safely.
- A decoder must reject unknown versions, never guess. An implementation may
  display "this mark uses HashMark version N, which this verifier does not
  support" — it must not display a digest read under an earlier version's rules.
  v2 is the concrete demonstration of why: it moves the label from push 3 to
  push 5, so a v1 parser reading a v2 record would report a signature as a
  label.
- An unknown version is **newer, not broken**, and must be presented that way.
- Version numbers are assigned in this document. New algorithm ids are assigned
  in §5.3.

## 10. Receipt format

A receipt is a convenience pointer that helps a verifier find a mark. **It is
never evidence.** See §2.7.

### 10.1 Example

```json
{
  "format": "hashmark-receipt",
  "version": 1,
  "network": "radiant-mainnet",
  "algorithm": "sha256",
  "digest": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "transactionId": "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
  "outputIndex": 0,
  "label": "Contract draft",
  "genesisHash": "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4"
}
```

### 10.2 Fields

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `format` | string | yes | exactly `"hashmark-receipt"` |
| `version` | integer | yes | `1` |
| `network` | string | yes | a known network id, e.g. `"radiant-mainnet"` |
| `algorithm` | string | yes | a supported algorithm name |
| `digest` | string | yes | lowercase hex, length matching the algorithm |
| `transactionId` | string | yes | 64 lowercase hex characters |
| `outputIndex` | integer | yes | ≥ 0 |
| `label` | string | no | the label as recorded on-chain |
| `genesisHash` | string | no | 64 lowercase hex; **must** match `network` when present |
| `expectedSigner` | string | no | base58 address the reader should expect (v2 marks); see below |

`expectedSigner` says who the reader should **expect**, not who signed. It is
compared against the signer the record commits to, **and the chain wins**: a
mismatch is a disagreement to report, never grounds to reject the record, and a
match is not evidence in itself since anyone can write a receipt. It is absent
for v1 marks, which have no signer to expect. Compare addresses by decoded
`(version byte, hash160)`, never as base58 strings.

Unknown keys are ignored rather than rejected, for forward compatibility. Adding
`expectedSigner` therefore did not require a receipt version bump: an older
reader skips the field rather than refusing the receipt.
A JSON Schema is published at [`receipt.schema.json`](packages/protocol/receipt.schema.json).

### 10.3 Validating a receipt

```
1. Reject input over 8 KB before parsing it.
2. Parse as JSON; reject on failure.
3. Check every field against §10.2. Collect all errors, not just the first.
4. If genesisHash is present, check it matches the named network.
   A receipt naming one chain while pointing at another is invalid.
5. Fetch transactionId from a node for that network.
6. Decode output outputIndex per §6.
7. Check the on-chain digest equals the receipt's digest.
8. Check the on-chain label equals the receipt's label (or that both are absent).
9. Only now report a result, and report it from the ON-CHAIN values —
   never from the receipt's.
```

Step 9 is the important one. Everything the user is shown must come from the
chain. The receipt's own fields are used only to locate the record and to warn
when they disagree with it.

A `version` higher than the verifier supports should be reported as "newer than
this verifier supports", not as corruption.

## 11. Indexing

Digest search requires an index. An index must:

1. Follow the chain and detect outputs matching the 10-byte prefix
   `6A 08 48 41 53 48 4D 41 52 4B`.
2. Parse and validate each per §6, storing only records that fully validate.
3. Store, at minimum: digest, algorithm id, version, txid, output index,
   height, **block hash**, and label.
4. Handle reorgs by deleting records above the fork height and re-adding them
   as the new chain is processed. The block hash makes this exact rather than
   inferred.
5. Never store a confirmation count, and never mark a record permanently
   confirmed. Confirmations are computed from the current tip.
6. Be able to rebuild completely from chain data alone. An index holds no
   authoritative state.
7. Return matches oldest-first. A digest may legitimately have many marks.
8. Reject partial-digest queries, which would allow enumeration.

Consumers must re-verify every result against the chain (§2.8).

RXinDexer implements this today, serving `GET /hashmark/{digest}`. The
specification, including a reference parser, is in
[`docs/RXINDEXER_HASHMARK_INDEX.md`](docs/RXINDEXER_HASHMARK_INDEX.md) — an
independent implementation should be able to work from it alone.

Note that an index is needed only to *search*. Verifying a mark you already
have a transaction id or receipt for needs nothing but a Radiant node (§7.3),
and that remains true whether or not any index exists.

## 12. Privacy considerations

- **The file never leaves the device.** Hashing is local. The protocol requires
  nothing but the digest.
- **A digest is not automatically private.** See §2.2 — low-entropy files are
  guessable.
- **The label is permanently public and permanently unerasable.** It cannot be
  edited or deleted after broadcast. Users must be warned before, not after.
- **Filenames must not be recorded by default.** A filename can reveal a
  client's name, a case number, or a person's identity. If a user opts in, it
  goes in the label like any other public text.
- **The following must never be recorded**: file contents, absolute file paths,
  IP addresses, wallet private data, hidden browser or device metadata, and
  local timestamps presented as authoritative.
- **The funding transaction is public.** The inputs, change address and amounts
  are visible on-chain and may link marks to each other or to a wallet's other
  activity. This is a property of the chain, not of this protocol, but users
  should understand it.
- **A v2 signer is a permanent, deliberate public link.** The property that
  makes a signer useful is exactly the property that costs privacy: it is
  stable, so anyone can find every mark signed by the same key and correlate
  them with each other and with that address's other chain activity, forever.
  v1 was never private either — the funding address was always visible — but v2
  makes the linkage intentional and trivial, with no heuristics required.

  For a publisher this is the point. For personal use it may not be wanted, and
  an implementation **must** say so before the signature is made, not after, and
  should offer the mitigation in the same breath: use a wallet kept only for
  marking.
- **Digests should not be sent to analytics.** A digest sent to a third party
  is a permanent, linkable identifier for a file.

## 13. Worked example

### 13.1 Encoded record

Input:

- algorithm `sha256`
- digest `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
  (this is `SHA-256("test")`)
- label `Contract draft`

Encoded `scriptPubKey`, 61 bytes:

```
6a
08 48415348 4d41524b
02 0101
20 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
0e 436f6e7472616374206472616674
```

As one hex string:

```
6a08484153484d41524b020101209f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a080e436f6e7472616374206472616674
```

Byte-by-byte:

| Bytes | Meaning |
| --- | --- |
| `6a` | `OP_RETURN` |
| `08` | push 8 bytes |
| `48415348 4d41524b` | `"HASHMARK"` |
| `02` | push 2 bytes |
| `01` | version = 1 |
| `01` | algorithmId = 1 (sha256) |
| `20` | push 32 bytes |
| `9f86…0a08` | the digest |
| `0e` | push 14 bytes |
| `436f…6674` | `"Contract draft"` |

### 13.2 Decoded record

```json
{
  "version": 1,
  "algorithmId": 1,
  "algorithm": "sha256",
  "digest": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "label": "Contract draft"
}
```

### 13.3 Minimal record, no label — 46 bytes

```
6a 08 48415348 4d41524b 02 0101 20 <32-byte digest>
```

### 13.4 Records that must be rejected

| Script (abbreviated) | Outcome |
| --- | --- |
| `76a914…88ac` (P2PKH) | `NOT_HASHMARK` |
| `6a 03 6d7367 06 736e6b00336b` (a real mainnet `OP_RETURN "msg"`) | `NOT_HASHMARK` |
| `6a 08 "HASHMARK" 02 0101 4c20 <32 bytes>` | `NOT_HASHMARK` — non-minimal push |
| `6a 08 "HASHMARK" 02 0101 1f <31 bytes>` | `INVALID` — digest width |
| `6a 08 "HASHMARK" 01 01 20 <32 bytes>` | `INVALID` — header not 2 bytes |
| `6a 08 "HASHMARK" 02 0101 20 <32> 02 "ok" 03 <3>` | `INVALID` — a v1 record has 3 or 4 pushes |
| `6a 08 "HASHMARK" 02 0201 20 <32 bytes>` | `INVALID` — claims v2 but has a v1 shape |
| `6a 08 "HASHMARK" 02 0301 20 <32 bytes>` | `UNKNOWN_VERSION` (3) — newer, not broken |
| `6a 08 "HASHMARK" 02 0102 20 <32 bytes>` | `UNKNOWN_ALGORITHM` (2) |
| `6a 08 "HASHMARK" 02 0101 20 <32> 02 fffe` | `INVALID` — label not UTF-8 |
| `6a 08 "HASHMARK" 02 0201 20 <32> 13 <19> 41 <65>` | `INVALID` — signer not 20 bytes |
| `6a 08 "HASHMARK" 02 0201 20 <32> 14 <20> 40 <64>` | `INVALID` — signature not 65 bytes |

A v1 record whose label carries a control character or a bidi override is **not**
in this table: it decodes, the record stands, and the label is withheld (§5.4).
The same label in a v2 record is `INVALID`.

### 13.5 A real v2 record — 133 bytes

Mainnet transaction
`a1a86ab4503901af4df3d092fcf668b07c03c5cd89240fe918ae70e02e045916`, output 0.
Every value below can be checked against the chain.

```
6a 08 48415348 4d41524b
   02 0201
   20 e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e
   14 26ba056431ec69cf27eabeaab250d99ddbd895d2
   41 1f750d18df9ab44ba66ced01285a5a067b9ebf7c8ff6b32dddb40cc276c5e98d
      4c2054937e44a40d7628d80cafdd6a372b0aae8f8bb31dbb4d975273a23e8c9771
```

Decoded: version 2, algorithm 1 (sha256), no label. The signature header byte is
`0x1f` = 31, inside `27..34`, giving recovery id 0 and a compressed key.

The statement it covers, byte for byte:

```json
{"v":"HashMark/v2","network":"0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4","signerHash160":"26ba056431ec69cf27eabeaab250d99ddbd895d2","algorithmId":"01","digest":"e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e"}
```

Recovering the public key over `magicHash` of that string and hashing it yields
`26ba0564…dbd895d2` — the signer the record commits to — which encodes as
`14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i`.

A conforming implementation should reproduce all of it from these bytes alone,
plus the mainnet genesis hash.

## 14. Implementing a verifier from scratch

You need no HashMark code and no Radiant library.

**Step 1 — Connect to a Radiant node.** Any ElectrumX server speaking protocol
1.4, over TCP or WebSocket, newline-delimited JSON-RPC:

```json
{"id":1,"method":"server.version","params":["my-verifier","1.4"]}
{"id":2,"method":"blockchain.transaction.get","params":["<txid>", true]}
```

Confirm you are on the right chain first:

```json
{"id":3,"method":"server.features","params":[]}
→ genesis_hash must equal
  "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4"
```

**Step 2 — Pull the output script.** From the verbose transaction, take
`vout[n].scriptPubKey.hex` and decode the hex to bytes.

**Step 3 — Decode it** with the algorithm in §6.1. It is about 60 lines in any
language; a complete Python reference is in
[`docs/RXINDEXER_HASHMARK_INDEX.md`](docs/RXINDEXER_HASHMARK_INDEX.md) §2.

**Step 4 — Hash the file** with the algorithm the record names, and compare
digests as bytes.

**Step 5 — Read the confirmation state** from the same verbose response:
`confirmations`, `blockhash`, `blocktime`. Apply §7.4, and present the
timestamp with the caveats in §8.

**Step 6 — Optionally check inclusion independently** with
`blockchain.transaction.get_merkle(<txid>, <height>)`, verifying the Merkle
branch against the block header from `blockchain.block.header(<height>)`. This
removes the need to trust the server's word that the transaction is in the
block.

### 14.1 Conformance checklist

**Reading v1 and v2.** An implementation conforms if it:

- [ ] accepts only a bare `OP_RETURN` first byte
- [ ] enforces minimal push encoding, rejecting `OP_0`, `OP_1`–`OP_16`,
      `OP_1NEGATE`, `OP_PUSHDATA4` and non-minimal `OP_PUSHDATA1/2`
- [ ] compares the magic as bytes
- [ ] requires a 2-byte header
- [ ] reads the version *before* checking the push count, since the count and
      the label's position both depend on it
- [ ] requires 3 or 4 pushes for v1 and 5 or 6 for v2
- [ ] reports unknown versions without interpreting them, as newer rather than
      broken, and checks the version *before* the algorithm
- [ ] derives digest length from the algorithm id, not the push length
- [ ] limits the label to 128 **bytes** in v1 and the derived cap in v2 (88 for
      sha256), requires strict UTF-8, and rejects the §5.4 character set
- [ ] withholds an unsafe v1 label without invalidating the record, and treats
      the same label in v2 as `INVALID`
- [ ] never trims or normalizes a label it has decoded
- [ ] distinguishes `NOT_HASHMARK` from `INVALID`
- [ ] never throws on arbitrary input
- [ ] renders digests as lowercase hex and rejects uppercase
- [ ] re-verifies every indexed result against the chain
- [ ] distinguishes unconfirmed, confirming and confirmed
- [ ] never presents a mark as proving authorship, ownership or legal validity

**Additionally, for v2 attestations:**

- [ ] rebuilds the canonical statement from the record's own fields plus the
      genesis hash of the chain the transaction was found on, never from
      caller-supplied values
- [ ] requires a 65-byte signature, header in `27..34`, `r` and `s` in range,
      and low-S
- [ ] **compares `hash160(recovered public key)` against the committed signer**,
      and never treats a recovered key as the signer on its own
- [ ] reports a failed signature as a failed *claim*, distinct from a malformed
      record, and never shows such a record as a mark
- [ ] encodes the displayed signer from the committed bytes, not from the
      recovered key
- [ ] compares any expected signer by decoded `(version byte, hash160)`, never
      as base58 strings
- [ ] warns, before signing, that a signature permanently links the mark to that
      key and to every other mark it signed
- [ ] presents marks by different signers with equal weight, and never ranks
      them or calls the earliest canonical
- [ ] if it resolves a signer through a naming system, either says so in the
      present tense or establishes the name's target at the mark's own block
      (§7.6) — never applies a present-day lookup to a past event
