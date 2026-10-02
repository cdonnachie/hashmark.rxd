# HashMark

**Leave your mark on the chain.**

Create permanent, independently verifiable proof that a file existed at a
specific time. Files remain private and never leave the browser.

Live at [hashmark.rxd.zone](https://hashmark.rxd.zone) · WAVE name `hashmark.rxd`

---

## What it does

A HashMark records a file's SHA-256 fingerprint in a Radiant transaction. The
block that confirms it fixes a time, so anyone can later show that the file
existed by then and has not changed since.

The file itself is never uploaded. Hashing happens in the browser, and only the
32-byte digest — plus an optional public label — is written to the chain.

A mark also carries a **signature over the statement it makes**, so it says which
key made it and not only when. That is what tells two marks of the same file
apart: anyone can mark any file, and without a signer the second mark is
indistinguishable from the first.

**A HashMark proves that someone knew a file's fingerprint no later than the
block that recorded it, and — for a signed record — that the holder of a
particular key said so.** It does not prove authorship, ownership, or that
anything in the file is true, and a signer is only meaningful to a reader who
already recognises that key. See [`HASHMARK_PROTOCOL.md`](HASHMARK_PROTOCOL.md)
§1.1 and §7.5.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev            # http://localhost:3000
```

Nothing else is required. There is no database, no migration step and no
background worker: HashMark reads the chain directly and stores nothing.

```bash
pnpm test           # unit tests
pnpm typecheck      # app + protocol package
pnpm lint
pnpm build          # production build
pnpm start          # serve the production build
pnpm test:e2e       # end-to-end + accessibility, against a production build
pnpm test:package   # build @hashmark/protocol and import it as plain Node ESM
```

Two scripts talk to the live chain and are run by hand, never in CI:

```bash
pnpm vectors                      # regenerate + verify protocol test vectors
npx tsx scripts/probe-chain.ts    # sanity-check the chain adapter against a node
```

## Architecture

```
packages/protocol/     the on-chain format. Zero dependencies, no framework.
                       Published on its own so a third party can write a
                       verifier without depending on this app.

src/lib/hashing/       streamed SHA-256 in the browser: progress + cancellation
src/lib/radiant/       address, signmessage, WAVE, ElectrumX client, chain
                       queries, unsigned tx construction, PSBT builder
src/lib/wallet/        the wallet boundary: adapter interface, Photonic
                       implementation, callback parsing, session storage
src/lib/verify.ts      the single definition of "verified"
src/app/               routes
scripts/               manual, network-touching tools
```

### Three rules the code keeps

1. **The file never leaves the browser.** There is no upload route — not a
   disabled one, none at all.
2. **The chain is the source of truth.** An index, a receipt or a URL is only a
   pointer saying what to fetch. Every result shown to a user is read back from
   a Radiant node and re-decoded. A wrong answer from an index can cause a
   *missing* result, never a false one.
3. **Never claim success early, and never claim more than is true.** A
   transaction is reported as broadcast only when a wallet confirms a txid;
   confirmation state is always computed from the current chain tip rather than
   stored; and any screen that says it is tracking a transaction actually polls
   until it settles.
4. **A block is proved, not reported.** The server hands over two Merkle
   branches and the block header; the transaction must lead to the header, and
   the header must lead to a checkpoint root this build ships. So a node cannot
   move a mark to a different block or date — it can only fail to answer, which
   the interface reports as "the node's word" rather than as a fault. Burial
   depth is not proved and is labelled so.
5. **A signer is matched, never derived.** A v2 record commits to the key that
   signed it, and verification recovers a key from the signature and requires it
   to hash to that commitment. Recovering a key and calling it the signer would
   prove nothing: for any chosen signature there is a key under which it
   verifies. A record whose signature does not hold is never shown as a mark.

### Making a mark takes three approvals

Photonic is a full-page round trip, and the three steps stay separate on
purpose:

```
1. connect            authorise this site, and prove which address
2. sign the statement the wallet shows the digest and label, and signs them
3. sign & broadcast   pay the fee and publish
```

Folding the attestation into the connect challenge would save an interaction and
cost the meaning of an approval: that challenge carries replay protection,
origin binding and session establishment, and Photonic badges it as a
*connection* rather than a message signature. A returning visitor with a live
connection pays two trips, not three.

Step 2 is also where consent actually happens — the wallet renders the statement
verbatim, so the user reads the fingerprint and label they are attesting to
rather than an opaque nonce.

### Why the browser talks to Radiant directly

Verification does not pass through this server. That is deliberate: it means
this site cannot fabricate a result, and it means verification keeps working
if the site disappears. The `/api/*` routes are a convenience for clients that
cannot open a WebSocket.

The one exception is *finding* a mark by fingerprint. The digest index is not
public, so the browser asks this server for pointers —
`/api/hashmarks/{digest}/hits`, a list of transaction ids — and then fetches
and decodes each of those transactions from a Radiant node itself. This site
is in the search path but not in the trust path: it can withhold a pointer, it
cannot invent a verification.

## Configuration

Every value is public — endpoints, the wallet URL, the explorer pattern.
HashMark holds no secrets: no keys, no database, no accounts. See
[`.env.example`](.env.example).

| Variable | Default |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | `https://hashmark.rxd.zone` |
| `NEXT_PUBLIC_ELECTRUM_SERVERS` | the two mainnet nodes running the HashMark index, comma-separated |
| `NEXT_PUBLIC_PHOTONIC_CONNECT_URL` | `https://photonic-wallet.com/#/connect` |
| `NEXT_PUBLIC_EXPLORER_TX_URL` | `https://explorer2.rxd-radiant.com/tx/{txid}` |
| `NEXT_PUBLIC_FEE_RATE` | `10000` photons per byte |
| `HASHMARK_INDEX_URL` | unset — fingerprint search is disabled without it. Comma-separated for failover |

`NEXT_PUBLIC_` values are inlined at build time. Set them **before**
`pnpm build`, not just at runtime. `HASHMARK_INDEX_URL` is the one variable
that is *not* public: the indexer sits on a private network, its address is
never shipped to a browser, and it is read at runtime, so changing it needs a
restart rather than a rebuild.

Servers are checked on connect: a node reporting a genesis hash other than
Radiant mainnet's is refused, so a misconfigured endpoint cannot serve testnet
data as mainnet.

## Digest search needs an indexer

Verifying a file by transaction id or receipt works against any Radiant node.
**Searching by fingerprint does not**, because no stock Radiant infrastructure
indexes data-output contents — `blockchain.opreturn.get`,
`blockchain.data.search` and `blockchain.hash.search` are all unknown methods,
and `blockchain.ref.get` indexes Glyph tokens rather than payloads.

RXinDexer fills that gap ([`docs/RXINDEXER_HASHMARK_INDEX.md`](docs/RXINDEXER_HASHMARK_INDEX.md)
specifies it), indexing both record versions, and exposes two REST endpoints:

```
GET /hashmark/{digest}?algorithm=sha256&limit=20   → hints, oldest first
GET /hashmark/stats                                → backfill progress
```

Point HashMark at it and fingerprint search works:

```bash
HASHMARK_INDEX_URL="http://10.0.0.5:8000"

# Or several, tried in order, so one index being down is a slower answer
# rather than "search is unavailable":
HASHMARK_INDEX_URL="http://10.0.0.5:8000,http://10.0.0.6:8000"
```

Spares are not cross-checked against each other. The index is a hint and every
hit is re-verified against the chain, so two indexes agreeing would prove
nothing that re-verification does not; availability is the only thing a spare
is for. An empty result from the first endpoint is the answer rather than a
reason to ask the next, since "never marked" is the common case.

REST rather than the ElectrumX `hashmark.lookup` method: it is plain HTTP from
the server that already has the index on its network, with no WebSocket to
keep alive and no unauthenticated method reachable by anyone who can connect to
a node.

Without it, `/verify` reports **"search is unavailable"**, which is deliberately
distinct from "no mark found" — those mean very different things to someone
checking a document. The same distinction is kept while the indexer is still
backfilling: `/hashmark/stats` reports `backfill_complete`, and until it is
true, an empty result is shown as "nothing found in what has been scanned",
not "never marked".

Nothing about this makes the index trusted. Every hit it returns is re-fetched
from a Radiant node and re-decoded before anyone sees it — and for a v2 record,
its signature is re-checked against the signer it commits to. A wrong or
tampered index costs a result; it cannot fabricate one. The indexer does not
verify signatures itself, and should not: it would need secp256k1 and the
genesis hash to prove something the client proves anyway.

## Refreshing the block-proof checkpoint

Block proofs anchor to one constant, `src/lib/radiant/checkpoint.ts`: a root
over every block header up to some height. Every mark below that height is
proved with about twenty hashes and stays proved forever, so a stale checkpoint
never breaks anything — marks newer than it simply fall back to the node's word,
which is all any mark got before. Refreshing is a ratchet, not a chore: do it
whenever you release for some other reason.

```bash
npx tsx scripts/gen-checkpoint.ts
```

It takes the root from the primary server, requires byte-identical agreement
from servers run by **other operators** (at least one independent agreement is
mandatory), then proves a real mainnet mark against the root with the same code
the application runs. A disagreement or a failed self-check prints nothing.
Paste the constant into `checkpoint.ts` and the fixture into
`src/lib/radiant/__fixtures__/inclusion-proof.json`; a test fails if the two are
out of step.

Two rules from the protocol document apply to this value. It is never fetched
at runtime — anything fetched may corroborate, nothing fetched may anchor. And
it is deliberately not coordinated with other implementations: independently
generated anchors are what would detect one of them being fed a false chain.

## Publishing the protocol package

`@hashmark/protocol` is meant to be usable by someone writing their own
verifier, with no bundler and no dependency on this application.

```bash
pnpm build:protocol   # tsc → dist/, then add ESM extensions to the emitted code
pnpm test:package     # import dist/ as plain Node ESM and check its behaviour
```

Development resolves the package through the `@hashmark/protocol` path alias in
`tsconfig.json`, straight to TypeScript source — so `dist/` is not needed to run
or build the app, and `pnpm dev` never requires a package build first.

`dist/` is what gets published, and `exports` points at it. Because the alias
hides whether the *built* output actually loads, `pnpm test:package` imports it
the way a stranger would and fails if the emitted specifiers are wrong. The
source uses extensionless relative imports for the bundlers this repo develops
against; `scripts/add-esm-extensions.mjs` adds the `.js` that Node's ESM loader
requires, since TypeScript will not rewrite specifiers on emit.

## Deployment (Ubuntu, Node, nginx)

Requires Node 20.9+.

```bash
git clone <repo> /var/www/hashmark && cd /var/www/hashmark
pnpm install --frozen-lockfile
cp .env.example .env && $EDITOR .env      # set NEXT_PUBLIC_APP_URL
pnpm build
```

The build emits a standalone server. Run it under a process manager:

```bash
pm2 start "node .next/standalone/server.js" --name hashmark
pm2 save
```

nginx, terminating TLS and proxying:

```nginx
server {
    listen 443 ssl http2;
    server_name hashmark.rxd.zone;

    ssl_certificate     /etc/letsencrypt/live/hashmark.rxd.zone/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hashmark.rxd.zone/privkey.pem;

    # A courtesy limit in front of the API routes. The app also limits per
    # process, but that does not survive multiple instances.
    limit_req_zone $binary_remote_addr zone=hashmark_api:10m rate=2r/s;

    location /api/ {
        limit_req zone=hashmark_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Do not add security headers at nginx.** The application sets a nonce-based CSP
and the full header set in `src/proxy.ts`. Duplicating headers at the proxy
produces two `Content-Security-Policy` values, and the browser applies the
intersection — which usually breaks the page in ways `curl` will not show you.

`X-Forwarded-For` must be set, or the API rate limiter buckets every visitor
into one key.

### Health check

```bash
curl -s https://hashmark.rxd.zone/api/health
# {"status":"ok","network":"radiant-mainnet","chainTip":459389,"latencyMs":203,
#  "search":"ok","backfillComplete":false}
```

`degraded` with HTTP 503 means no configured Radiant node could be reached. It
reports nothing else on purpose: no versions, no hostnames, no paths.

`search` is the digest index, and it is reported rather than fatal — the site
works without it, minus fingerprint search. It reads `ok`, `unavailable`
(configured but not answering) or `not-configured` (no `HASHMARK_INDEX_URL`).

## API

Read-only, rate limited, no authentication. All optional.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Service and chain reachability |
| `GET /api/transactions/{txid}` | Parsed HashMark records in a transaction |
| `GET /api/hashmarks/{digest}` | Marks for a digest, each re-verified on-chain |
| `GET /api/hashmarks/{digest}/hits` | Index pointers only, for callers that verify themselves |

A mark in a response carries its `signer` when the record is v2 and its
signature verified against the signer it commits to. A record whose signature
does **not** hold is never returned as a mark: it appears under `problems` with
`kind: "attestation"`, kept distinct from a malformed record, because "the bytes
were wrong" and "the claim did not hold" are different answers.

Both hashmark routes return **501** when the index cannot be searched — never
404, and never an empty list, because "cannot search" must not be read as
"nothing found". Partial digests are refused with 400 rather than matched as a
prefix, which would allow enumeration.

## Troubleshooting

**"Could not reach a Radiant node."**
The browser connects directly over WebSocket. A corporate proxy or firewall
blocking `wss://` on non-standard ports will cause this. Try another server in
`NEXT_PUBLIC_ELECTRUM_SERVERS`, and check `/api/health` — if that is `ok`, the
server can reach the chain and the block is on the client side.

**"Search is unavailable."**
`HASHMARK_INDEX_URL` is unset, or the indexer is not answering. Check
`/api/health`: `search` reads `not-configured` in the first case and
`unavailable` in the second. Verification by transaction id and by receipt is
unaffected either way.

**The wallet returns but nothing happens.**
Photonic only honours a `callback` whose origin exactly matches the `origin` in
the request. If `NEXT_PUBLIC_APP_URL` does not match the origin the user is
actually browsing, the wallet drops the callback. In the browser the live origin
is used, so this usually only bites a misconfigured production build.

**"This result does not match any request from this browser tab."**
The pending request lives in `sessionStorage`. Reloading the tab, or returning
in a different tab, loses it. This is the replay guard working — start again.

**A CSP error in the console.**
`connect-src` lists exactly the configured Radiant nodes. Adding a server to
`NEXT_PUBLIC_ELECTRUM_SERVERS` requires a rebuild, because the CSP is generated
from the same value.

**Confirmation count is stuck at zero.**
The result and transaction pages poll every 30 seconds until a mark reaches six
confirmations, then stop. Polling pauses while the tab is hidden and resumes on
return. If it stays at zero for more than a few blocks, the transaction may have
been dropped from the mempool — open it in an explorer to check.

**Fonts render as system sans.**
The `next/font` variables must be on `<html>`, not `<body>`: the theme declares
`--font-display: var(--font-martian), …` at `:root`, and a custom property whose
value references an undefined variable is invalid at computed-value time.

## Independent implementations

The point of publishing a specification rather than just a verifier is that
someone else can build one and disagree with you. That has happened.

- **[pyrxd](https://github.com/MudwoodLabs/pyrxd)** (Python) both **writes and
  verifies** HashMark records, with a CLI (`pyrxd mark`, `pyrxd verify`) and a
  [browser verifier](https://mudwoodlabs.github.io/pyrxd/verify/). Its encoder
  and decoder were written from [`HASHMARK_PROTOCOL.md`](HASHMARK_PROTOCOL.md)
  alone, without reference to this codebase.

  It also implements §7.6 form 2 — resolving a WAVE name at the mark's own
  block by walking the name's update chain, and requiring two servers on
  different hosts to agree before reporting a result.

The interop goes both ways, which is the part that matters:

- pyrxd verifies our signed mark
  (`a1a86ab4…045916`) and recovers the same signer.
- This implementation reads **pyrxd's** mark
  (`aa66b04662aa5514ed7d0027ff3cbd608d73f3e2b92d4129d810eb576bc0c86e`), its
  signature verifies against the signer that record commits to, and our encoder
  re-emits pyrxd's bytes exactly. That record marks the `pyrxd 0.25.1` wheel,
  and its digest is the sha256 of the 1,722,880-byte file PyPI serves —
  confirmed by hashing the artifact rather than trusting PyPI's own digest.

Two tools built from one document, each reading records the other wrote, is
what "anyone can verify this" means in practice. Both sides keep the other's
marks as fixtures, so drift in either direction shows up quickly.

If you write another, §14 of the protocol document is the conformance checklist,
and §13 has worked examples — including a real mainnet v2 record you can check
byte by byte.

## Documentation

- [`HASHMARK_PROTOCOL.md`](HASHMARK_PROTOCOL.md) — **the specification.** Both
  record versions, the threat model, validation rules, the canonical statement a
  v2 signature covers, worked examples and a conformance checklist. Everything
  needed to write an independent verifier.
- [`packages/protocol/receipt.schema.json`](packages/protocol/receipt.schema.json)
  — JSON Schema for receipts
- [`docs/HASHMARK_V2_ATTESTATION.md`](docs/HASHMARK_V2_ATTESTATION.md) — why v2
  is shaped the way it is: the attacks that drove it, the alternatives rejected.
  Rationale, not specification; implement from the protocol document
- [`docs/RXINDEXER_HASHMARK_INDEX.md`](docs/RXINDEXER_HASHMARK_INDEX.md) — the
  indexer specification
- [`docs/PHASE1_ARCHITECTURE.md`](docs/PHASE1_ARCHITECTURE.md) — a dated record
  of the original investigation: what was verified about Radiant, Photonic and
  RXinDexer before any code existed. Deliberately not kept current

## Security

HashMark never handles a seed phrase or a private key, and no field in the
application could accept one. Signing happens in the user's own wallet.

Report a vulnerability privately rather than opening a public issue.

## Licence

MIT.
