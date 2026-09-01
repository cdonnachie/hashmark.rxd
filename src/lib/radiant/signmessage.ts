import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import * as varuint from "varuint-bitcoin";

/**
 * Bitcoin-style "signmessage" verification.
 *
 * Ported from the SURF.RXD project (`src/lib/radiant/signmessage.ts`), where
 * it is verified byte-for-byte against real signatures produced by the
 * Photonic wallet. Keep the two in sync if either changes.
 *
 * The scheme (Bitcoin Core's `src/util/message.cpp`, mirrored by every fork):
 *
 *     hash   = sha256d(CompactSize(prefix) || prefix || CompactSize(msg) || msg)
 *     sig    = 65 bytes: header || r || s, base64-encoded
 *     header = 27 + recoveryId (0..3) + (4 if the pubkey is compressed)
 *
 * Verification recovers the public key from (hash, sig) and compares its
 * hash160 against the one inside the claimed base58check address. The
 * address's version byte is chain-specific and irrelevant to the comparison.
 *
 * ## Why this is the right primitive for a connect handshake
 *
 * The magic prefix is load-bearing. It guarantees a signed-message digest can
 * never collide with a raw transaction sighash, so a site cannot dress a
 * spendable transaction up as a "message" and trick a wallet into signing it.
 * That property is what makes it safe for HashMark to ask a user's wallet to
 * sign a challenge — and it is why HashMark never asks for anything else.
 */

/** Radiant kept Bitcoin's prefix. Confirmed against real Photonic signatures. */
export const RADIANT_MESSAGE_PREFIX = "Bitcoin Signed Message:\n";

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** sha256d of both strings, each length-prefixed with Bitcoin's CompactSize. */
export function magicHash(message: string, rawPrefix: string): Uint8Array {
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(rawPrefix);
  const messageBytes = encoder.encode(message);
  const payload = concat(
    new Uint8Array(varuint.encode(prefixBytes.length).buffer),
    prefixBytes,
    new Uint8Array(varuint.encode(messageBytes.length).buffer),
    messageBytes,
  );
  return sha256(sha256(payload));
}

/**
 * Base58check-decode any single-version-byte P2PKH address to its 20-byte
 * hash160. Deliberately version-agnostic: which chain the address belongs to is
 * the caller's concern (see address.ts for the Radiant-specific check).
 */
function hash160FromBase58Address(address: string): Uint8Array | undefined {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    return undefined;
  }
  if (decoded.length !== 25) return undefined; // 1 version + 20 hash160 + 4 checksum
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) return undefined;
  }
  return payload.subarray(1);
}

function base64ToBytes(base64: string): Uint8Array | undefined {
  try {
    if (typeof atob === "function") {
      const binary = atob(base64);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return undefined;
  }
}

/**
 * Verify a base64 signmessage signature against a P2PKH address. Returns false
 * — never throws — on any malformed input.
 *
 * Only legacy P2PKH header bytes (27..34) are accepted; the segwit variants
 * (35..42) do not exist on Radiant.
 */
export function verifyBitcoinStyleSignedMessage(params: {
  address: string;
  message: string;
  signatureBase64: string;
  messagePrefix: string;
}): boolean {
  try {
    const addressHash160 = hash160FromBase58Address(params.address);
    if (!addressHash160) return false;

    const sigBytes = base64ToBytes(params.signatureBase64);
    if (!sigBytes || sigBytes.length !== 65) return false;

    const header = sigBytes[0]!;
    if (header < 27 || header > 34) return false;
    const recoveryId = (header - 27) & 3;
    const compressed = header >= 31;

    const signature = secp256k1.Signature.fromBytes(
      sigBytes.subarray(1),
      "compact",
    ).addRecoveryBit(recoveryId);

    const publicKey = signature
      .recoverPublicKey(magicHash(params.message, params.messagePrefix))
      .toBytes(compressed);
    const recoveredHash160 = ripemd160(sha256(publicKey));

    for (let i = 0; i < 20; i++) {
      if (recoveredHash160[i] !== addressHash160[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce a signmessage-compatible base64 signature. HashMark never holds a
 * user's private key — this exists only so the two halves of the scheme live
 * together and so tests can exercise verification against a known-good
 * signature.
 */
export function signBitcoinStyleMessage(params: {
  privateKey: Uint8Array;
  message: string;
  messagePrefix: string;
  compressed?: boolean;
}): string {
  const compressed = params.compressed ?? true;
  const hash = magicHash(params.message, params.messagePrefix);
  // "recovered" format = 65 bytes: recoveryId (0..3) || r || s
  const recovered = secp256k1.sign(hash, params.privateKey, {
    prehash: false,
    format: "recovered",
  });
  const header = 27 + recovered[0]! + (compressed ? 4 : 0);
  const sig = concat(Uint8Array.of(header), recovered.subarray(1));
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of sig) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(sig).toString("base64");
}

/**
 * Verify a signature against a claimed Radiant address. Returns false, never
 * throws, on any malformed input.
 */
export function verifyRadiantSignedMessage(
  address: string,
  message: string,
  signatureBase64: string,
): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  if (typeof address !== "string" || typeof signatureBase64 !== "string") {
    return false;
  }
  return verifyBitcoinStyleSignedMessage({
    address,
    message,
    signatureBase64,
    messagePrefix: RADIANT_MESSAGE_PREFIX,
  });
}
