import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

/**
 * Radiant address encoding.
 *
 * Ported from the SURF.RXD project (`src/lib/radiant/address.ts`), which
 * carries the original test fixtures and is the source of truth for this
 * scheme. Keep the two in sync if either changes.
 */

// 1-byte version + 20-byte hash160 + 4-byte checksum.
const P2PKH_DECODED_LENGTH = 25;

// Radiant kept Bitcoin's original address format rather than assigning its own
// version byte the way Avian/Ravencoin did, so mainnet addresses are legacy
// P2PKH and start with "1", exactly like Bitcoin.
const RADIANT_P2PKH_VERSION = 0x00;

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

/**
 * Decode a base58check Radiant address to its 20-byte hash160, or undefined if
 * it is not a well-formed legacy P2PKH address. Pure computation, no network.
 */
export function decodeRadiantAddress(address: string): Uint8Array | undefined {
  if (!address) return undefined;
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address.trim());
  } catch {
    return undefined;
  }
  if (decoded.length !== P2PKH_DECODED_LENGTH) return undefined;

  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  if (!bytesEqual(checksum, doubleSha256(payload).slice(0, 4))) return undefined;
  if (payload[0] !== RADIANT_P2PKH_VERSION) return undefined;

  return payload.slice(1);
}

export function isValidRadiantAddress(address: string): boolean {
  return decodeRadiantAddress(address) !== undefined;
}

/**
 * `ripemd160(sha256(bytes))` — the 20-byte hash a P2PKH address encodes.
 *
 * Defined here rather than beside its two callers so there is exactly one
 * implementation: an attestation's committed signer and the address it is
 * compared against must be derived the same way, or verification fails for a
 * reason that looks like a bad signature.
 */
export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/**
 * The inverse of {@link decodeRadiantAddress}: a 20-byte hash160 to its
 * base58check address.
 *
 * A v2 record commits to a signer as raw hash160 bytes, so this is what turns
 * a verified attestation into something a person can read and compare against
 * an explorer.
 */
export function encodeRadiantAddress(hash: Uint8Array): string {
  if (hash.length !== 20) {
    throw new Error("encodeRadiantAddress: hash160 must be 20 bytes");
  }
  const payload = new Uint8Array(21);
  payload[0] = RADIANT_P2PKH_VERSION;
  payload.set(hash, 1);

  const out = new Uint8Array(P2PKH_DECODED_LENGTH);
  out.set(payload, 0);
  out.set(doubleSha256(payload).slice(0, 4), payload.length);
  return bs58.encode(out);
}

/** Legacy P2PKH: OP_DUP OP_HASH160 PUSH20 <hash160> OP_EQUALVERIFY OP_CHECKSIG. */
export function p2pkhScript(hash160: Uint8Array): Uint8Array {
  if (hash160.length !== 20) {
    throw new Error("p2pkhScript: hash160 must be 20 bytes");
  }
  const script = new Uint8Array(25);
  script.set([0x76, 0xa9, 0x14], 0);
  script.set(hash160, 3);
  script.set([0x88, 0xac], 23);
  return script;
}

/** The P2PKH scriptPubKey an address pays to, or undefined if it is invalid. */
export function scriptForAddress(address: string): Uint8Array | undefined {
  const hash160 = decodeRadiantAddress(address);
  return hash160 === undefined ? undefined : p2pkhScript(hash160);
}

/**
 * Electrum's scripthash: sha256 of the scriptPubKey, **reversed**. This is the
 * key for `blockchain.scripthash.*` methods.
 *
 * Not to be confused with RXinDexer's WAVE `hashX`, which is the first 11 bytes
 * of the same sha256 and is *not* reversed (see wave.ts). Mixing them up
 * produces empty results rather than an error, so they are deliberately kept
 * in separate functions with this note.
 */
export function electrumScriptHash(address: string): string | undefined {
  const script = scriptForAddress(address);
  if (script === undefined) return undefined;
  const digest = sha256(script);
  return [...digest]
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `14XmXG3d…vgx1i` — for showing a connected wallet without the full string. */
export function shortenAddress(address: string, edge = 6): string {
  if (address.length <= edge * 2 + 1) return address;
  return `${address.slice(0, edge)}…${address.slice(-edge)}`;
}
