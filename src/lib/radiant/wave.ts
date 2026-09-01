import { sha256 } from "@noble/hashes/sha2.js";

import { decodeRadiantAddress, p2pkhScript } from "./address";
import type { ElectrumClient } from "./electrum";

/**
 * WAVE Name lookups via RXinDexer.
 *
 * Ported from the SURF.RXD project (`src/lib/radiant/wave.ts`). HashMark uses
 * only the reverse direction: given the address a wallet just proved control
 * of, show a name instead of a base58 string.
 *
 * A WAVE name here is **cosmetic**. It is never used to authorize anything, and
 * a failed lookup degrades silently to a shortened address.
 */

const RXD_SUFFIX = ".rxd";
const RXD_DEFAULT_ZONE = "rxd";

export interface WaveResolveResult {
  name?: string;
  ref?: string;
  /**
   * The name's resolved owner address. Use this, **not** `zone`, which is
   * separate user-set DNS-style data and can point anywhere.
   */
  target?: string;
  zone?: unknown;
  /** Truncated hashX. One-way: a hashX cannot be turned back into an address. */
  owner?: string;
  available?: boolean;
  canonical?: boolean;
}

/**
 * RXinDexer's owner `hashX`: the first 11 bytes of `sha256(scriptPubKey)`,
 * **not reversed**.
 *
 * Deliberately distinct from the 32-byte reversed Electrum scripthash used by
 * `blockchain.scripthash.*` (see `electrumScriptHash` in address.ts). Passing
 * one where the other is expected returns empty results rather than an error,
 * so the two are kept apart and named differently.
 */
export function waveHashX(address: string): string | undefined {
  const hash160 = decodeRadiantAddress(address);
  if (hash160 === undefined) return undefined;
  return [...sha256(p2pkhScript(hash160)).slice(0, 11)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve a WAVE name to its owner.
 *
 * Takes either `"hashmark"` or `"hashmark.rxd"` but strips the suffix before
 * calling: the raw JSON-RPC method wants the bare label and errors with
 * `Invalid character: .` on the suffixed form. (The REST mirror strips it
 * server-side; the socket method does not.)
 */
export async function resolveWaveName(
  client: ElectrumClient,
  name: string,
): Promise<WaveResolveResult | null> {
  const bare = name.toLowerCase().endsWith(RXD_SUFFIX)
    ? name.slice(0, -RXD_SUFFIX.length)
    : name;
  if (!/^[a-z0-9-]{1,64}$/i.test(bare)) return null;

  try {
    return (
      (await client.call<WaveResolveResult | null>("wave.resolve", [bare])) ??
      null
    );
  } catch {
    return null;
  }
}

interface ReverseLookupHit {
  ref?: string;
  name?: string;
  domain?: string;
}

/** A bare label gets a zone appended; an already-qualified name is left alone. */
function qualify(name: string, domain?: string): string {
  return name.includes(".") ? name : `${name}.${domain ?? RXD_DEFAULT_ZONE}`;
}

/**
 * Every WAVE name owned by `address`, lowercased and fully qualified.
 *
 * Returns an empty array rather than throwing: this is display sugar, and a
 * name-service outage must never block verifying a file.
 */
export async function waveNamesForAddress(
  client: ElectrumClient,
  address: string,
  limit = 50,
): Promise<string[]> {
  const hashX = waveHashX(address);
  if (!hashX) return [];

  let hits: ReverseLookupHit[] | null;
  try {
    hits = await client.call<ReverseLookupHit[] | null>("wave.reverse_lookup", [
      hashX,
      limit,
    ]);
  } catch {
    return [];
  }
  if (!Array.isArray(hits)) return [];

  const names = new Set<string>();
  for (const hit of hits) {
    if (typeof hit?.name === "string" && hit.name.length > 0) {
      names.add(qualify(hit.name, hit.domain).toLowerCase());
    }
  }
  return [...names].sort();
}

/*
 * There is deliberately no `primaryWaveName`.
 *
 * An earlier version picked the shortest name, on the theory that it was the
 * one an owner identifies with. That holds for someone with one or two names
 * and fails completely past that: an address holding thirteen names showed a
 * demo registration, chosen over the owner's own name by two characters and a
 * tie-break on the first letter. Which name someone "means" is not derivable
 * from the set, so the caller gets the whole set and shows it honestly.
 */
