import { describe, expect, it } from "vitest";

import { RADIANT_MESSAGE_PREFIX, signBitcoinStyleMessage } from "@/lib/radiant/signmessage";

import { interpretCallback, parseFragment } from "./callback";
import type { PendingRequest } from "./photonic";

/**
 * Wallet callbacks are untrusted input arriving in a URL fragment. These tests
 * are mostly about what must be *refused*: a result with no matching request, a
 * signature for a different challenge, a signature from a different address,
 * and a "broadcast" that never actually broadcast anything.
 */

const TEST_KEY = new Uint8Array(32).fill(0x22);

const TEST_ADDRESS = (() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { secp256k1 } = require("@noble/curves/secp256k1.js");
  const { ripemd160 } = require("@noble/hashes/legacy.js");
  const { sha256 } = require("@noble/hashes/sha2.js");
  const bs58 = require("bs58").default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const pubkey = secp256k1.getPublicKey(TEST_KEY, true);
  const payload = new Uint8Array(21);
  payload.set(ripemd160(sha256(pubkey)), 1);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(sha256(sha256(payload)).subarray(0, 4), 21);
  return bs58.encode(full) as string;
})();

const CHALLENGE = "radiant:wallet-connect:v1:nonce123:HashMark sign-in | hashmark.rxd";

function connectPending(): PendingRequest {
  return {
    kind: "connect",
    id: "nonce123",
    nonce: "nonce123",
    challenge: CHALLENGE,
    createdAt: Date.now(),
  };
}

function broadcastPending(): PendingRequest {
  return {
    kind: "broadcast",
    id: "req1",
    nonce: "",
    digest: "a".repeat(64),
    outputIndex: 0,
    createdAt: Date.now(),
  };
}

function signedFragment(message = CHALLENGE, address = TEST_ADDRESS): string {
  const signature = signBitcoinStyleMessage({
    privateKey: TEST_KEY,
    message,
    messagePrefix: RADIANT_MESSAGE_PREFIX,
  });
  return `#nonce=nonce123&address=${encodeURIComponent(address)}&signature=${encodeURIComponent(signature)}`;
}

describe("parseFragment", () => {
  it("decodes base64 signature padding correctly", () => {
    const params = parseFragment("#signature=abc%2Bdef%2F%3D%3D&address=1x");
    expect(params.get("signature")).toBe("abc+def/==");
    expect(params.get("address")).toBe("1x");
  });

  it("tolerates a missing leading hash", () => {
    expect(parseFragment("a=1").get("a")).toBe("1");
  });
});

describe("connect callbacks", () => {
  it("accepts a correctly signed challenge", () => {
    const outcome = interpretCallback(
      parseFragment(signedFragment()),
      connectPending(),
    );
    expect(outcome.kind).toBe("connected");
    if (outcome.kind === "connected") {
      expect(outcome.address).toBe(TEST_ADDRESS);
    }
  });

  it("refuses a result with no pending request — the replay guard", () => {
    const outcome = interpretCallback(parseFragment(signedFragment()), null);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/does not match any request/);
    }
  });

  it("refuses a signature over a different challenge", () => {
    const outcome = interpretCallback(
      parseFragment(signedFragment("radiant:wallet-connect:v1:other:elsewhere")),
      connectPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/does not match that address/);
    }
  });

  it("refuses a valid signature attributed to a different address", () => {
    const fragment = signedFragment(
      CHALLENGE,
      "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i",
    );
    const outcome = interpretCallback(parseFragment(fragment), connectPending());
    expect(outcome.kind).toBe("error");
  });

  it("refuses a nonce belonging to another request", () => {
    const fragment = signedFragment().replace("nonce=nonce123", "nonce=other");
    const outcome = interpretCallback(parseFragment(fragment), connectPending());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/different request/);
    }
  });

  it("refuses a malformed address before checking any signature", () => {
    const outcome = interpretCallback(
      parseFragment("#address=not-an-address&signature=AAAA"),
      connectPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/not a Radiant address/);
    }
  });

  it("refuses a result missing the signature entirely", () => {
    const outcome = interpretCallback(
      parseFragment(`#address=${TEST_ADDRESS}`),
      connectPending(),
    );
    expect(outcome.kind).toBe("error");
  });
});

describe("broadcast callbacks", () => {
  it("accepts a transaction id", () => {
    const txid = "b".repeat(64);
    const outcome = interpretCallback(
      parseFragment(`#id=req1&txid=${txid}&complete=true`),
      broadcastPending(),
    );
    expect(outcome.kind).toBe("broadcast");
    if (outcome.kind === "broadcast") expect(outcome.txid).toBe(txid);
  });

  it("refuses a result whose id belongs to a different request", () => {
    // The wallet echoes the request id. One that is not ours means this result
    // came from some other round trip, so the transaction it names is not the
    // one this tab asked for.
    const outcome = interpretCallback(
      parseFragment(`#id=someone-else&txid=${"b".repeat(64)}&complete=true`),
      broadcastPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/different request/i);
    }
  });

  it("lowercases an uppercase transaction id", () => {
    const outcome = interpretCallback(
      parseFragment(`#txid=${"B".repeat(64)}&complete=true`),
      broadcastPending(),
    );
    expect(outcome.kind).toBe("broadcast");
    if (outcome.kind === "broadcast") expect(outcome.txid).toBe("b".repeat(64));
  });

  it("refuses a malformed transaction id", () => {
    const outcome = interpretCallback(
      parseFragment("#txid=nope&complete=true"),
      broadcastPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/not a transaction id/);
    }
  });

  it("never claims success when a PSBT came back instead of a txid", () => {
    const outcome = interpretCallback(
      parseFragment("#psbt=cHNidP8B&complete=false"),
      broadcastPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/nothing was broadcast/i);
    }
  });

  it("distinguishes a signed-but-not-accepted transaction", () => {
    const outcome = interpretCallback(
      parseFragment("#psbt=cHNidP8B&complete=true"),
      broadcastPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/not accepted by the network/);
    }
  });

  it("treats an empty return as a failure, never as success", () => {
    const outcome = interpretCallback(parseFragment(""), broadcastPending());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/Nothing was published/);
    }
  });
});

describe("wallet-reported failures", () => {
  it("reads a rejection as a rejection, not an error", () => {
    const outcome = interpretCallback(
      parseFragment("#error=rejected&message=User%20declined"),
      connectPending(),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.message).toBe("User declined");
    }
  });

  it.each(["denied", "cancelled", "user_rejected"])(
    "treats %s as a rejection",
    (code) => {
      expect(
        interpretCallback(parseFragment(`#error=${code}`), connectPending()).kind,
      ).toBe("rejected");
    },
  );

  it("surfaces a locked wallet as an error", () => {
    const outcome = interpretCallback(
      parseFragment("#error=locked&message=Wallet%20is%20locked"),
      connectPending(),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toBe("Wallet is locked");
  });

  it("reports an error even with no pending request", () => {
    expect(interpretCallback(parseFragment("#error=locked"), null).kind).toBe(
      "error",
    );
  });
});
