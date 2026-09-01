/**
 * Runtime configuration.
 *
 * Every value here is public by design — endpoints, the wallet URL, the
 * explorer link pattern. HashMark has no secrets: it holds no keys, stores no
 * files and has no database. If a value ever needs hiding, it does not belong
 * in this application.
 *
 * `NEXT_PUBLIC_` variables are inlined at build time, so they must be set
 * before `next build`, not merely at runtime.
 */

import { RADIANT_MAINNET } from "@hashmark/protocol";
import type { NetworkInfo } from "@hashmark/protocol";

function splitList(value: string | undefined, fallback: readonly string[]) {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

/**
 * ElectrumX servers, tried in order.
 *
 * Deliberately only these two. The browser dials them directly for chain reads,
 * and beyond the standard ElectrumX methods it needs two RXinDexer additions:
 * `refs` on a UTXO, without which coin selection cannot tell a token-bearing
 * output apart and would build a transaction the wallet refuses to sign; and
 * `wave.reverse_lookup`, which resolves the names shown beside a connected
 * wallet. A general-purpose Radiant node answers neither.
 *
 * Digest search does NOT run over these sockets — it goes through this
 * application's own API to the RXinDexer REST index (see HASHMARK_INDEX_URL),
 * because that index is not public.
 *
 * Order matters — the first is tried first — and a server reporting a genesis
 * hash other than Radiant mainnet's is refused at connect time by
 * {@link ElectrumClient}, so a wrong endpoint cannot serve another chain's data
 * as if it were ours.
 */
export const ELECTRUM_SERVERS: readonly string[] = splitList(
  process.env.NEXT_PUBLIC_ELECTRUM_SERVERS,
  [
    "wss://electrumx.rxd-radiant.com:50011",
    "wss://electrumx-eu.rxd-radiant.com:50011",
  ],
);

export const NETWORK: NetworkInfo = RADIANT_MAINNET;

/**
 * Photonic's hosted wallet. The connect route is a **web hash route**
 * (`#/connect?req=…`), not a custom URL scheme — Photonic's own docs are
 * explicit that auto-return is web-only. Override for local wallet development.
 */
export const PHOTONIC_CONNECT_URL =
  process.env.NEXT_PUBLIC_PHOTONIC_CONNECT_URL ??
  "https://photonic-wallet.com/#/connect";

/**
 * Explorer link pattern. HashMark only ever *links* here — it never fetches
 * from an explorer, so bot protection on the explorer is irrelevant to us.
 */
export const EXPLORER_TX_URL =
  process.env.NEXT_PUBLIC_EXPLORER_TX_URL ??
  "https://explorer2.rxd-radiant.com/tx/{txid}";

export function explorerTxUrl(txid: string): string {
  return EXPLORER_TX_URL.replace("{txid}", encodeURIComponent(txid));
}

/** The site's own public origin, used to origin-bind wallet callbacks. */
export const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? "https://hashmark.rxd.zone"
).replace(/\/$/, "");

export const APP_NAME = "HashMark";
export const APP_WAVE_NAME = "hashmark.rxd";
export const APP_TAGLINE = "Leave your mark on the chain.";

/**
 * Fee rate in photons per byte.
 *
 * Matches Photonic's own default (`feeRate` in its config.json) rather than the
 * node's far lower `relayfee`. Deliberate: the wallet applies its own
 * fee-sanity check before signing, and a transaction priced below what it
 * expects risks being refused at the approval screen. Paying the wallet's rate
 * is the reliable choice, and the cost is fractions of an RXD.
 */
export const FEE_RATE_PHOTONS_PER_BYTE = Number(
  process.env.NEXT_PUBLIC_FEE_RATE ?? 10_000,
);

/** Photons in one RXD. */
export const PHOTONS_PER_RXD = 100_000_000;

export function formatRxd(photons: number): string {
  const rxd = photons / PHOTONS_PER_RXD;
  if (rxd === 0) return "0 RXD";
  if (rxd < 0.00001) return `${photons.toLocaleString()} photons`;
  return `${rxd.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} RXD`;
}
