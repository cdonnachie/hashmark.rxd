# Adding a HashMark digest index to RXinDexer

A specification for the smallest change to RXinDexer that removes HashMark's
need for a separate indexer.

> **Status: implemented, and extended for v2.** RXinDexer serves this index
> today. HashMark consumes the **REST surface** (§5), server-side, via
> `HASHMARK_INDEX_URL` — see the README. The ElectrumX method below remains
> specified for other clients but is not what HashMark calls.
>
> **Both record versions are indexed.** The layout below is v1. A v2 record
> (docs/HASHMARK_V2_ATTESTATION.md) has 5 or 6 pushes — the digest is followed
> by a 20-byte committed signer and a 65-byte signature, and the label moves
> from push 3 to push 5. That move is exactly why an unknown version must never
> be read under a known version's rules: a v1 parser let loose on a v2 record
> would index a signature as a label.
>
> Consequences for this document: the script cap is **223 bytes**, not 176; the
> label cap is 128 for v1 and 88 for v2; a lookup hit carries `signer_hash160`
> for v2 rows; and `/hashmark/stats` reports `protocol_versions: [1, 2]`
> alongside the original `protocol_version`.
>
> The signature is **not verified by the indexer**, and should not be. Doing so
> needs secp256k1 and the chain's genesis hash, and would change nothing:
> HashMark re-fetches every hit and checks the signature against the committed
> signer itself. A row is a pointer, and an unverified pointer is all this index
> has ever been (§6).

**Why this is worth doing.** Digest lookup is the one HashMark operation no
existing Radiant infrastructure can serve: `blockchain.opreturn.get`,
`blockchain.data.search` and `blockchain.hash.search` are all `unknown method`,
and `blockchain.ref.get` indexes Glyph refs, not data-output payloads. Without
this, HashMark must run a second process that follows blocks, handles reorgs,
tracks confirmations and exposes an API — duplicating four things RXinDexer
already does well. Adding ~200 lines here replaces a whole service, and makes
digest lookup available to *any* Radiant application, not just ours.

---

## 1. What to index

During block processing, for every transaction output, test the
`scriptPubKey` against this prefix — **10 bytes, one comparison**:

```
6a 08 48 41 53 48 4d 41 52 4b
│  │  └───────────────────────  ASCII "HASHMARK"
│  └──────────────────────────  push of 8 bytes
└─────────────────────────────  OP_RETURN
```

In Python:

```python
HASHMARK_PREFIX = bytes.fromhex("6a0848415348 4d41524b".replace(" ", ""))

if script_pub_key.startswith(HASHMARK_PREFIX):
    record = parse_hashmark(script_pub_key)
```

The prefix test is cheap enough to run on every output. Outputs that fail it
are not HashMarks and must be skipped silently — the overwhelming majority of
`OP_RETURN` outputs on Radiant belong to other protocols.

## 2. Record format

Full specification in `HASHMARK_PROTOCOL.md`. Restated here so this document
is self-contained:

```
OP_RETURN
  <push 8>  "HASHMARK"                      magic
  <push 2>  version(uint8) ‖ algorithmId(uint8)
  <push N>  digest, N fixed by algorithmId  (sha256 = id 0x01, N = 32)
  <push L>  label, OPTIONAL, 1..128 bytes UTF-8
```

Maximum total script size is 176 bytes. A record is 3 or 4 pushes; anything
else is malformed.

**This section, and the reference parser below, describe v1 only.** v2 is
implemented and indexed — see the status note at the top of this document, and
`HASHMARK_PROTOCOL.md` for the normative definition of both. The shape of the
v2 changes is: 5 or 6 pushes, a 20-byte signer and a 65-byte signature after the
digest, the label at push 5, a 223-byte script ceiling and an 88-byte label cap.

### Reference parser

```python
from dataclasses import dataclass

MAGIC = b"HASHMARK"
ALGORITHMS = {0x01: ("sha256", 32)}
MAX_LABEL_BYTES = 128

@dataclass(frozen=True)
class HashMarkRecord:
    version: int
    algorithm_id: int
    algorithm: str
    digest: str          # lowercase hex
    label: str | None

def read_pushes(script: bytes, offset: int) -> list[bytes] | None:
    """Every push must be MINIMALLY encoded, or the record is rejected.

    Minimal encoding is what gives a record exactly one valid serialization,
    so two independent encoders produce identical bytes and records can be
    compared byte-for-byte. OP_0 and OP_1..OP_16 are rejected: they would give
    a one-byte field a second spelling.
    """
    pushes, i = [], offset
    while i < len(script):
        op = script[i]; i += 1
        if 0x01 <= op <= 0x4b:
            n = op
        elif op == 0x4c:                       # OP_PUSHDATA1
            if i >= len(script): return None
            n = script[i]; i += 1
            if n <= 0x4b: return None          # non-minimal
        elif op == 0x4d:                       # OP_PUSHDATA2
            if i + 1 >= len(script): return None
            n = script[i] | (script[i + 1] << 8); i += 2
            if n <= 0xff: return None          # non-minimal
        else:
            return None                        # OP_0, OP_1..OP_16, OP_PUSHDATA4, …
        if n > 520 or i + n > len(script): return None
        pushes.append(script[i:i + n]); i += n
    return pushes

def parse_hashmark(script: bytes) -> HashMarkRecord | str:
    """Returns a record, or a failure reason string."""
    if not script or script[0] != 0x6A:
        return "NOT_HASHMARK"
    pushes = read_pushes(script, 1)
    if pushes is None or not pushes or pushes[0] != MAGIC:
        return "NOT_HASHMARK"

    # From here the output claims to be a HashMark, so failures are real.
    if not (3 <= len(pushes) <= 4):
        return "INVALID"
    if len(pushes[1]) != 2:
        return "INVALID"

    version, algorithm_id = pushes[1][0], pushes[1][1]
    if version != 1:
        # Do NOT index a future version as v1: a later version may redefine
        # every field after the header.
        return "UNKNOWN_VERSION"
    if algorithm_id not in ALGORITHMS:
        return "UNKNOWN_ALGORITHM"

    name, digest_len = ALGORITHMS[algorithm_id]
    if len(pushes[2]) != digest_len:
        return "INVALID"

    label = None
    if len(pushes) == 4:
        raw = pushes[3]
        if len(raw) > MAX_LABEL_BYTES:
            return "INVALID"
        try:
            label = raw.decode("utf-8")       # strict: no replacement chars
        except UnicodeDecodeError:
            return "INVALID"
        if any(ord(c) < 0x20 or ord(c) == 0x7F for c in label):
            return "INVALID"                  # control characters

    return HashMarkRecord(version, algorithm_id, name,
                          pushes[2].hex(), label)
```

## 3. Storage

```sql
CREATE TABLE hashmark (
    digest       BYTEA   NOT NULL,   -- raw bytes, not hex
    algorithm_id SMALLINT NOT NULL,
    version      SMALLINT NOT NULL,
    txid         BYTEA   NOT NULL,   -- 32 bytes, internal byte order
    output_index INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    block_hash   BYTEA   NOT NULL,   -- REQUIRED: this is what makes reorgs correct
    label        TEXT,
    PRIMARY KEY (txid, output_index)
);

CREATE INDEX hashmark_digest_idx ON hashmark (digest, algorithm_id);
CREATE INDEX hashmark_height_idx ON hashmark (height);
```

Two notes that matter:

- **`digest` is not unique.** The same file can be marked many times, by
  different people at different times. A lookup returns a *list*, ordered by
  height ascending — the earliest confirmed mark is the meaningful one.
- **`block_hash` is not optional.** Storing height alone makes reorg handling
  guesswork; storing the block hash makes it exact (§4).

## 4. Reorg handling

Reuse whatever RXinDexer already does for its other indexes. The requirement:

- On a reorg to height `H`, delete every row with `height > H`. Rows are then
  re-added as the new chain is processed. Deletion is safe because the table is
  a pure projection of chain data — it holds nothing that cannot be rebuilt.
- A row's presence must never be treated as "confirmed forever". Confirmations
  are computed at query time as `tip_height - height + 1`, never stored.
- Mempool HashMarks should **not** be written to this table. If mempool
  visibility is wanted later, use a separate table or a `height IS NULL`
  convention, so an unconfirmed mark can never be mistaken for a confirmed one.

## 5. Query API

Two surfaces, matching how RXinDexer already exposes WAVE.

### ElectrumX JSON-RPC (optional)

```
hashmark.lookup(digest_hex, algorithm_id=1, limit=20)
```

```jsonc
// → oldest first; [] when nothing matches (not an error)
[
  {
    "txid": "…64 hex…",
    "output_index": 0,
    "height": 459123,
    "block_hash": "…64 hex…",
    "version": 1,
    "algorithm": "sha256",
    "digest": "…64 hex…",
    "label": "Contract draft"      // omitted when absent
  }
]
```

Validate `digest_hex` against `^[0-9a-f]{64}$` for sha256 and reject anything
else, rather than doing a `LIKE` or a prefix match — a partial-digest search
would let someone enumerate the index.

### REST (what HashMark uses)

```
GET /hashmark/{digest}?algorithm=sha256&limit=20
```

Same body, same CORS and rate-limit treatment as the existing `/wave/*` routes
(`Access-Control-Allow-Origin`, 600 req/min per IP).

Chosen over the JSON-RPC method for HashMark's own use: it is plain HTTP from
the one server that already has the index on its network, with no WebSocket to
keep alive and no unauthenticated method exposed to everyone who can reach a
node. `[]` must mean "not marked", and any failure must be a non-200 — an error
rendered as an empty list would read to a user as "your file was never marked".

A status route makes the difference between "not marked" and "not scanned yet"
answerable:

```
GET /hashmark/stats
→ {"enabled": true, "backfill_complete": false,
   "backfill_target_height": 459475, "backfill_next_height": 292400,
   "pending_rows": 0, "algorithms": {"sha256": 1}, "protocol_version": 1}
```

HashMark reads `enabled` and `backfill_complete` from it: while the backfill is
incomplete it says "nothing found in what has been scanned" rather than
"never marked", and an index reporting `enabled: false` is treated as
unavailable rather than as an empty result.

**Access logs.** A digest is a linkable identifier for a file, and this route
puts one in the request path. An operator who cares about that should turn off
access logging for `/hashmark/*` or strip the path from it — the same reason
HashMark logs nothing on its own side.

## 6. What HashMark still does itself

Even with this deployed, HashMark **re-verifies every hit** by fetching the raw
transaction with `blockchain.transaction.get` and re-decoding the output in the
browser. The index is treated as a search hint, never as the proof. That is
deliberate and unchanged by this feature: it means a compromised or buggy
indexer can cause a *missed* result, but never a *false* one.

So the trust requirement on this feature is low — it must not lose records, but
it does not have to be trusted to be right.

## 7. Test vectors

```
Record with no label (46 bytes):
6a0848415348 4d41524b020101 20 aaaa…aa   (32 × 0xaa)
  → version 1, sha256, digest "aaaa…aa" (64 hex chars), no label

Record with label "hi" (49 bytes):
6a0848415348 4d41524b020101 20 aaaa…aa 02 6869
  → same, label "hi"

Must be REJECTED:
6a0848415348 4d41524b020101 1f …            digest 31 bytes → INVALID
6a0848415348 4d41524b020201 20 …            version 2       → UNKNOWN_VERSION
6a0848415348 4d41524b020102 20 …            algorithm 2     → UNKNOWN_ALGORITHM
6a0848415348 4d41524b0201014c20 aaaa…aa     non-minimal push → NOT_HASHMARK
6a036d7367 06 736e6b00336b                  another protocol → NOT_HASHMARK
```

(Spaces above are for readability only; the real scripts are contiguous bytes.)

The TypeScript reference implementation and its 69 tests live in
`packages/protocol/` in the HashMark repository and can be ported directly.
