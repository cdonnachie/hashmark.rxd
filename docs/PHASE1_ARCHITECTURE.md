# HashMark — Phase 1: Investigation & Architecture


> **A dated record, not current documentation.** This is the Phase 1
> investigation, written before any code existed, and it is kept because what
> was *known and unknown at the time* is the useful part — which capabilities
> were verified against mainnet, which were ruled out, and why the shape of the
> project followed.
>
> Several things in it have since changed and are **not** corrected here, on
> purpose: digest search now exists (RXinDexer indexes it, so the separate
> Prisma indexer described in §6 was never built); records are 5 or 6 pushes in
> v2, not 3 or 4, with an 88-byte label rather than 128; and the CSP no longer
> needs the indexer's origin, because that index is reached server-side.
>
> For what is true now, read [`HASHMARK_PROTOCOL.md`](../HASHMARK_PROTOCOL.md)
> and the [README](../README.md).

Status: **proposal awaiting sign-off**. Everything marked ✅ was verified against
real source, a live node, or mainnet data on 2026-08-28; ❌ marks a capability
that does **not** exist and that the design must route around.

Sources of truth used (no capability below is assumed from documentation alone):

| Source | Used for |
| --- | --- |
| [`Radiant-Core/Radiant-Core`](https://github.com/Radiant-Core/Radiant-Core) | Consensus + relay/standardness policy |
| [`Radiant-Core/RXinDexer`](https://github.com/Radiant-Core/RXinDexer) | ElectrumX + REST API surface |
| [`Radiant-Core/Photonic-Wallet`](https://github.com/Radiant-Core/Photonic-Wallet) | `photonic-connect` wallet protocol, PSBT wire format |
| [`MudwoodLabs/pyrxd`](https://github.com/MudwoodLabs/pyrxd) | Independent (Python) verifier reference |
| `cdonnachie/surf-rxd` (private) | **Working reference integration** — Photonic + WAVE, house style |
| `npm @radiant-core/radiantjs@2.0.6` | Installed and read in source |
| `wss://electrumx.rxd-radiant.com:50011` | Live node probes, mainnet block scan |
| `https://explorer2.rxd-radiant.com/` | Explorer links |

---

## 1. Repository state

`C:\development\hashmark.rxd` is **empty** — greenfield. No existing stack
dictates technology, so the preferred stack in the brief applies as written.

## 2. The data-carrier question — resolved against mainnet

This is the most consequential finding, and it **reverses** the brief's
suggestion of a "provably unspendable" `OP_FALSE OP_RETURN` output.

### 2.1 Radiant Core contradicts itself ⚠️

Two places in Radiant Core disagree about what a data output looks like:

`src/script/script.h:882` — the *pruning* notion of unspendable:
```cpp
bool IsUnspendable() const {
    // We currently only detect OP_FALSE OP_RETURN as provably unspendable.
    return (size() > 1 && *begin() == OP_FALSE && *(begin() + 1) == OP_RETURN);
}
```

`src/script/standard.cpp:122` — the *standardness* classifier, whose comment
claims to use the test above but whose code does not call it:
```cpp
// So long as script passes the IsUnspendable() test and all but the first
// byte passes the IsPushOnly() test we don't care what exactly is in the script.
if (scriptPubKey.size() >= 1 && scriptPubKey[0] == OP_RETURN &&
    scriptPubKey.IsPushOnly(scriptPubKey.begin() + 1)) {
    return TX_NULL_DATA;
}
```

`Solver()` matches `TX_NULL_DATA` only on a **bare `OP_RETURN`** first byte.
An `OP_FALSE OP_RETURN …` script starts with `0x00`, falls through every
branch, and returns `TX_NONSTANDARD`. In `IsStandardTx` (`policy.cpp:78`) that
is rejected with `reason = "scriptpubkey"`, and because Radiant's
`IsDust` is `nValue <= 0` (`policy.cpp:23`) — with the dust check skipped
*only* for `TX_NULL_DATA` — a 0-value `OP_FALSE OP_RETURN` output would fail
twice over.

**So `radiantjs`'s `Script.buildSafeDataOut()` / `Transaction.addSafeData()`
produce an output that current Radiant Core standardness would not relay.**

### 2.2 Mainnet confirms it ✅

Scanned the 6 most recent blocks (459372–459377) via
`blockchain.transaction.id_from_pos` + verbose `transaction.get`, 58
transactions, classifying every output's `scriptPubKey.hex`:

```
bare OP_RETURN  (6a…)   :  7      ← all value 0
OP_FALSE OP_RETURN (006a…) :  0
```

Real example, block 459373, output 2, value 0:
```
6a 03 6d7367 06 736e6b00336b
OP_RETURN "msg" <6 bytes>
```

Every data carrier on mainnet is a **bare `OP_RETURN`**, and the existing
convention is already `OP_RETURN <short protocol tag> <payload…>` — exactly the
shape HashMark wants.

### 2.3 Decision

HashMark v1 uses a **bare `OP_RETURN`** data output: `radiantjs`
`Script.buildDataOut()` / `Transaction.addData()`, **not** the `SafeData`
variants. The output is still unspendable in practice — `OP_RETURN` aborts
script evaluation immediately — it simply is not flagged by Core's
`IsUnspendable()` pruning helper. `HASHMARK_PROTOCOL.md` will state this
precisely rather than claiming provable unspendability.

### 2.4 Size budget ✅

`src/script/standard.h`:
```cpp
static constexpr uint32_t MAX_OP_RETURN_RELAY      = 223;   // Bitcoin-style
static constexpr uint32_t DEFAULT_DATACARRIER_BYTES = 1024;  // Radiant default
uint32_t nMaxDatacarrierBytes = DEFAULT_DATACARRIER_BYTES;   // standard.cpp:18
```
`IsStandardTx` sums `scriptPubKey.size()` across **all** `TX_NULL_DATA` outputs
and rejects above `nMaxDatacarrierBytes` (default **1024**).

Our envelope is at most **176 bytes** (measured, §4.2). That fits under 1024
*and* under the conservative 223, so HashMark relays even on a node configured
with the Bitcoin-style limit. Staying ≤223 is an explicit design constraint.

## 3. Confirmed Radiant capabilities

### 3.1 `@radiant-core/radiantjs` v2.0.6 ✅ — with one bug to route around

Installed and read in source.

| Capability | Evidence |
| --- | --- |
| `Script.buildDataOut(data[])` → `OP_RETURN <push>…` | `lib/script/script.js:1106` |
| `Transaction.addData(value)` — 0-photon output, `isDataOut() === true` | `transaction.js:800` (verified by execution) |
| Multi-push accepted: pass an **array** of Buffers | verified by execution |
| Dust rule exempts data outputs | `transaction.js:300` |
| `Transaction.FEE_PER_KB = 10_000_000` photons/KB (10 000/byte) | `transaction.js:89` |
| `MAX_SCRIPT_ELEMENT_SIZE = 520` per push | `lib/script/interpreter.js:286` |
| `Message.sign` / `Message.verify` (recoverable, magic-prefixed) | `lib/message.js` |
| Radiant FORKID sighash with extra `hashOutputHashes` | `Transaction.Sighash` |

⚠️ **`Script.prototype.getData()` is unusable for our decode path.** For a bare
data-out it returns `Buffer.from(this.chunks[1].buf)` — the **first push only**
(`script.js:729`). It returns all pushes *only* for the safe-data-out form we
are not using. Verified by execution: a 4-push HashMark record returns one
8-byte buffer. Our decoder therefore walks `script.chunks` (in fact, raw script
bytes — the `packages/protocol` decoder has no radiantjs dependency at all).

Encoder output verified by execution:
```
no label : 6a08484153484d41524b0201012000…   46 bytes
max label:                                   176 bytes
```
A 1-byte buffer encodes as a direct push `0x01 0x01`, not `OP_1` — but the
format below avoids relying on that by using a single 2-byte header push.

### 3.2 Live ElectrumX / RXinDexer ✅

Primary endpoint (yours) `wss://electrumx.rxd-radiant.com:50011`, probed live:
```
server.version    → ["ElectrumX 1.4.1", "1.4"]
server.features   → rxindexer_version "RXinDexer 3.0.1", protocol_max "1.4.2"
                    genesis_hash "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4"
headers.subscribe → height 459378 (at tip)
relayfee          → 0.000001
transaction.get   → verbose OK: confirmations, blockhash, blocktime, vout[].scriptPubKey.hex
```
Fallbacks, also verified live: `wss://electrumx.radiantcore.org`,
`wss://electrumx.radiant4people.com:50022`. All three report the same genesis
hash and tip height.

Methods confirmed present: `blockchain.transaction.get` (verbose),
`.broadcast`, `.get_merkle`, `.id_from_pos`, `blockchain.block.header(s)`,
`blockchain.scripthash.listunspent` / `get_history` / `get_balance` /
`subscribe`, `blockchain.ref.get`, `blockchain.relayfee`,
`blockchain.estimatefee`, `mempool.get_fee_histogram`.

### 3.3 RXinDexer public REST API ✅

`docs/REST_API.md`, verified live at `https://radiantcore.org/api`:
```
GET /health                  → {"status":"healthy","database":"connected","sync_height":459377}
GET /transaction/{txid}      → raw transaction by id
GET /wave/resolve/{name}     → name → target
GET /wave/reverse/{scripthash} → names owned by a scripthash
Access-Control-Allow-Origin: * (exactly one header — browser-callable)
Rate limit: 600 req/min per IP (REST_RATE_LIMIT_PER_MIN), HTTP 429 on excess
```
Also offers `ws://…/ws` mempool subscriptions by scripthash — useful for
watching our own transaction land without polling.

### 3.4 ❌ There is still **no** digest / OP_RETURN search

Probed and rejected as `unknown method`: `blockchain.opreturn.get`,
`blockchain.data.search`, `blockchain.hash.search`. The REST API indexes
Glyphs, dMint, and WAVE — not arbitrary data-output payloads.
`blockchain.ref.get` exists but indexes Radiant **refs** (glyph tokens).

**Consequence:** "drop a file in and find its mark" cannot be served by
existing infrastructure. **An indexer is mandatory**, not conditional.

> **Resolved, 2026-08-31.** This was closed by extending RXinDexer rather than
> by building a second service: it already follows blocks, handles reorgs and
> tracks confirmations, so duplicating that would have been waste. It now
> indexes HashMark outputs and serves `GET /hashmark/{digest}`, backfilled over
> the whole chain. HashMark consumes it server-side via `HASHMARK_INDEX_URL`.
> See docs/RXINDEXER_HASHMARK_INDEX.md. The finding above is left as written,
> as the record of what was true at the time.
This is the one component we cannot borrow.

## 4. Confirmed Photonic Wallet capabilities

Photonic ships a real, documented external connection protocol:
**`photonic-connect` v1** (`packages/app/src/connect/protocol.ts`, 1395 lines;
`docs/psbt.md`; `docs/mint-request.md`).

### 4.1 Transport ✅ — deep link, not an injected provider

```
<walletUrl>#/connect?req=<base64url(JSON envelope)>
```

There is **❌ no `window.photonic` provider, no extension postMessage bridge,
no custom URL scheme.** `docs/psbt.md` §6 says so outright: "`#/connect?req=` is
a web hash route, not a custom URL scheme; auto-return is web-only."

Results return in the **URL fragment** to a `callback` whose origin must exactly
equal the envelope's declared `origin` (`cleanCallback` also rejects relative
URLs, embedded credentials, and non-http(s) schemes). Fragment, never query — so
a result never reaches a server access or proxy log.

### 4.2 Request types we use ✅

**`sign-request`** — connect and prove address control:
```ts
{ protocol:"photonic-connect", v:1, t:"sign-request",
  challenge:string, id?, origin?, app?, address?, callback? }
→ { t:"sign-result", address, pubkey, signature }
// callback fragment: #nonce=…&address=…&signature=…
```
Recognized challenge shape `<ns>:wallet-connect:v<n>:<nonce>:<label>`
(`CONNECT_CHALLENGE_RE`). The signature is radiantjs `Message` format, so we
verify it with `Message.verify(msg, address, sig)` before trusting the address.

**`psbt-sign-request`** — sign **and broadcast** the HashMark transaction:
```ts
{ protocol:"photonic-connect", v:1, t:"psbt-sign-request",
  psbt:string /* base64|base64url, ≤65536 chars */, broadcast?:true,
  id?, origin?, app?, callback? }
→ { t:"psbt-sign-result", psbt?, txid?, complete }
// callback fragment: #id=…&txid=…&complete=true
```
`broadcast: true` (the literal) makes the wallet finalize → extract →
broadcast and return a **txid**. Callback URL capped at 8192 bytes.

Wallet-side hard refusals to design around: token-bearing inputs, sighash
missing `SIGHASH_FORKID`, `SIGHASH_NONE`, the wallet's own UTXO record
disagreeing with our declared prevout, fee above `MAX_REASONABLE_FEE_RATE`.

### 4.3 ❌ `@photonic/lib` is not published to npm

A pnpm workspace package (`@photonic/lib` v3.0.1) with no registry entry —
verified 404. **We implement our own PSBT builder.** Low risk: we only ever
*serialize*; we never sign, and never parse a wallet-supplied PSBT for value.
Format read in full from `packages/lib/src/psbt/{psbt,keyvalue}.ts`:

```
magic       70 73 62 74 ff
global map  key 0x00 PSBT_GLOBAL_UNSIGNED_TX = legacy-serialized unsigned tx
            0x00 separator
per input   key 0x00 PSBT_IN_UTXO = bare CTxOut: int64-LE value ‖ varint scriptPubKey
            0x00 separator
per output  0x00 separator (we emit no output entries)
```
Framing `varint keylen ‖ keytype(varint) ‖ keydata`, then
`varint vallen ‖ value`; CompactSize must be **minimally encoded**; transport is
standard padded base64. Radiant's `PSBT_IN_UTXO` is a bare `CTxOut`, **not**
BIP-174's `non_witness_utxo` full previous transaction — there is no segwit, and
key types 0x01/0x05/0x08 do not exist in this profile.

### 4.4 WAVE names ✅ — via ElectrumX, not REST

`surf-rxd` resolves WAVE names over the **ElectrumX JSON-RPC socket**, which is
simpler than the REST mirror and is what we will use. Both verified live on
`wss://electrumx.rxd-radiant.com:50011`:

```
wave.resolve("hashmark")            → { name, ref, target, zone, owner, available, canonical }
wave.reverse_lookup(hashX, limit)   → [{ ref, name?, domain?, zone, owner }]
```

Two details that are easy to get wrong, both taken from `surf-rxd`:

- `wave.resolve` wants the **bare label** (`"hashmark"`), not the suffixed form.
  The suffixed name errors with `Invalid character: .` (the REST mirror strips
  it server-side; the raw RPC does not).
- The reverse-lookup key is RXinDexer's **`hashX`: the first 11 bytes of
  `sha256(p2pkhScriptPubKey(hash160))`, not reversed** — deliberately different
  from the standard 32-byte reversed Electrum scripthash. Verified: address
  `14XmXG3d…vgx1i` → `e4bf68e0c8eb9018f15fa0`, matching the `owner` field
  returned by `wave.resolve`.
- Use the `target` field for the owning address, **not** `zone` — `zone` is
  separate user-set DNS-style data and can point anywhere.

✅ **`hashmark.rxd` is registered — to your address.** Live on your indexer:
```
wave.resolve("hashmark") → { ref: "99bbca71…4da6_0",
  target: "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i", available: false, canonical: true }
```
(The public `radiantcore.org/api` mirror still reports `available: true` — its
index is stale. Your own RXinDexer is authoritative and is what we query.)

### 4.5 ⚠️ The UTXO-discovery burden lands on us

`docs/mint-request.md` §2 says it explicitly: a `psbt-sign-request` requires the
dApp to know which coins to spend, because unlike `mint-request` the wallet does
**not** self-fund a PSBT. So HashMark must (1) learn the address via
`sign-request`, (2) query `blockchain.scripthash.listunspent` itself, (3) select
coins and compute change, (4) hand over a fully-specified unsigned transaction.

Chosen deliberately over `mint-request`, which self-funds but mints a Glyph NFT
with an allow-listed MIME payload — the wrong shape, and far more expensive, for
a timestamp.

⚠️ **Token-bearing UTXOs must be filtered out before coin selection.**
`blockchain.scripthash.listunspent` on Radiant returns a Radiant-specific
`refs` array per UTXO (verified live):
```json
{"tx_hash":"e16f4f9d…286d","tx_pos":1,"height":443187,"value":1250020180000,"refs":[]}
```
Photonic **hard-refuses** to sign any input spending a token-bearing output
(`signPsbt` → `TOKEN_BEARING_INPUT`, `docs/psbt.md` §5). Selecting a UTXO with a
non-empty `refs` would make the whole request fail at the approval screen. Coin
selection therefore takes only `refs.length === 0` UTXOs — and doing so also
protects the user's tokens, which is the reason the wallet refuses in the first
place.

## 5. Proposed on-chain format — HashMark v1

Output 0 of the transaction, value 0, bare `OP_RETURN`, 3 or 4 pushes,
positional, no delimiters:

```
OP_RETURN
  <push1> "HASHMARK"      8 bytes, ASCII, exact
  <push2> vv aa           2 bytes: version (uint8) ‖ algorithm id (uint8)
  <push3> <digest>        length fixed by algorithm id (32 for sha256)
  <push4> <label>         OPTIONAL, 1..128 bytes, UTF-8 NFC, no C0/DEL
```

Measured sizes (by execution, §3.1): **46 bytes** without a label, **176 bytes**
with a maximal 128-byte label — under both the 1024 default and the
conservative 223 limit.

Why this shape:
- **Positional pushes, not a delimited blob** — a truncated record fails
  structurally instead of parsing into a plausible wrong digest.
- **Version and algorithm in one 2-byte push** — a 1-byte push risks
  `OP_1`-vs-`0x01 0x01` ambiguity across encoders; a 2-byte push has exactly one
  minimal encoding.
- **Digest length derived from the algorithm id**, never from the push length,
  so a truncated digest is rejected rather than accepted at the wrong width.
- The `OP_RETURN <tag> <payload>` shape matches what mainnet already does.

Validation rules — all must hold, otherwise the record is `INVALID`; never a
partial or best-effort result:
- `script[0] === OP_RETURN` and the remainder is push-only.
- Exactly 3 or 4 data pushes; 5+ is `INVALID`, not "ignore the extras".
- Push 1 byte-equals `HASHMARK`, else **`NOT_HASHMARK`** — a status distinct
  from `INVALID`, because most `OP_RETURN`s on Radiant belong to other protocols.
- Version ≠ 1 → `UNKNOWN_VERSION` carrying the observed version. Never coerced
  to v1, never rendered as a verified mark.
- Unknown algorithm id → `UNKNOWN_ALGORITHM`. Digest push length must equal the
  algorithm's declared length exactly.
- Label ≤128 **UTF-8 bytes** (not characters); must decode as strict UTF-8; no
  control characters; NFC-normalized on encode, compared bytewise on decode;
  always rendered escaped, never as HTML.
- Minimal push encoding required, so every record has exactly one canonical
  serialization (a 32-byte digest pushed via `OP_PUSHDATA1` is rejected).

## 6. Proposed architecture

```
packages/protocol/        framework-free TS, zero runtime deps, publishable
  encode.ts decode.ts     HashMark envelope ⇄ raw script bytes
  algorithms.ts           id ⇄ { name, digestLength }
  receipt.ts + schema     versioned JSON receipt + JSON Schema + validator

src/                      Next.js App Router app (surf-rxd layout)
  lib/hashing/            Web Worker: File.stream() → chunked SHA-256,
                          progress + AbortController cancellation
  lib/radiant/            address.ts signmessage.ts message.ts wave.ts
                          electrum-client.ts  ← ported from surf-rxd
    tx.ts                 unsigned tx serialization + coin selection
    psbt.ts               PSBT builder (serialize only)
    connect-link.ts       photonic-connect envelope builder
  lib/wallet/             WalletAdapter interface; photonic.ts + dev-only mock.ts
  app/                    / /create /verify /tx/[txid] /receipt /protocol /privacy
  app/api/                /hashmarks/[digest] /transactions/[txid] /health

scripts/scan-worker.ts    indexer: follows blocks, parses OP_RETURN outputs,
                          validates, indexes digest→(txid,vout,height),
                          reorg-aware, fully rebuildable from chain
prisma/                   PostgreSQL — disposable index ONLY, never authoritative
```

### Stack — matching `surf-rxd`

Next.js 16.2.10 · React 19.2.4 · TypeScript strict · Tailwind v4 · shadcn/ui
(Radix) · Prisma 6 + PostgreSQL · zod 4 · sonner · lucide-react ·
next-safe-action · Playwright.

**No `radiantjs` at runtime.** `surf-rxd` deliberately reimplements the small
amount of Radiant it needs on `@noble/hashes`, `@noble/curves`, `bs58` and
`varuint-bitcoin`, and we do the same — it keeps `packages/protocol`
dependency-free and avoids radiantjs's Buffer/`process` browser shims. We never
sign, so we never need its FORKID sighash; an *unsigned* legacy transaction is
plain serialization.

`radiantjs` stays a **devDependency**, used only to generate golden test
vectors: our hand-rolled encoder must byte-match `Script.buildDataOut`, which is
already verified to produce
`6a08484153484d41524b0201012000…` for a HashMark v1 record.

⚠️ **Next.js 16 is not the Next.js in my training data.** Per `surf-rxd`'s
`AGENTS.md`, read `node_modules/next/dist/docs/` before writing app code and
heed deprecation notices. I will do that immediately after install.

**The chain is the source of truth.** Every indexer hit is re-verified in the
browser by fetching the raw transaction over ElectrumX and re-decoding the
output. The API returns pointers; the UI never renders "verified" from a
database row alone.

Per your decisions: **PostgreSQL** for the index, and first-run backfill **from
deploy height** (`INDEXER_START_HEIGHT`, with a documented full-rebuild path).

### Confirmation and reorg policy
`unconfirmed` (mempool; first-seen time, explicitly *not* proof) →
`confirming` (1–5) → `confirmed` (≥6). The indexer stores the block hash with
every record and, on a header reorg, walks back and re-validates. A record is
never permanently marked confirmed until its block is on the active chain.

## 7. Security and privacy decisions

- File bytes never leave the browser: hashing in a Worker; no upload endpoint
  exists at all — not merely unused.
- The digest reaches our indexer **only on the verify path**, over TLS, never
  logged with an IP, never sent to analytics (there is no analytics in the MVP).
- Filename, size and MIME are shown locally and **never** put on-chain or
  POSTed. Filename is opt-in only, and even then only via the label the user
  types.
- `network` binds to the genesis hash `0000…3fb4` (identical across all four
  probed servers), not a string label, so a testnet receipt cannot be read as
  mainnet.
- Receipts are untrusted input: schema-validated, then the referenced
  transaction and output are fetched and re-decoded before anything shows valid.
- Strict CSP; `connect-src` limited to our API, the configured ElectrumX WSS
  hosts, and the RXinDexer REST origin.
- No seed phrase, WIF or private-key input exists anywhere in the codebase.

## 8. Open items and risks

1. ~~`hashmark.rxd` is unregistered~~ — **resolved**: it is registered to your
   address (§4.4).
2. **Explorer links** — `https://explorer2.rxd-radiant.com/` is live but behind
   Cloudflare bot protection (a scripted `GET /tx/{txid}` returns 403 "Just a
   moment…"; a real browser is unaffected). Link pattern is therefore
   configurable via `NEXT_PUBLIC_EXPLORER_TX_URL`, and we never server-side
   fetch the explorer — we only link to it.
3. ~~Photonic hosted wallet URL unknown~~ — **resolved** from `surf-rxd`:
   `https://photonic-wallet.com/#/connect`, overridable via
   `NEXT_PUBLIC_PHOTONIC_CONNECT_URL` for local wallet dev.
4. **Deep-link round trip loses in-page state.** Pending create state lives in
   `sessionStorage` keyed by request `id`, holding the digest — never the file —
   reconciled on callback return.
5. **Fee policy divergence.** `blockchain.relayfee` reports 0.000001 while
   Radiant Core's `DEFAULT_MIN_RELAY_TX_FEE_PER_KB` is 1 000 000 photons/kB and
   Photonic defaults to 10 000 photons/**byte**. We match Photonic (the highest)
   so the wallet's own fee-sanity check never rejects our PSBT, and show the cost
   in RXD before approval. A ~400-byte transaction ≈ 0.04 RXD.
6. **Radiant Core's `IsUnspendable()` / `Solver()` inconsistency** (§2.1) is
   upstream, not ours. If a future release makes `OP_FALSE OP_RETURN` the
   standard form, HashMark v2 can add it; the version byte exists for exactly
   this. Worth reporting upstream.
