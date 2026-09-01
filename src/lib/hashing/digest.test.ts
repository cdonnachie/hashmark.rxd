/**
 * Anchors our streamed SHA-256 to two independent references:
 *
 *  1. The published NIST / RFC 6234 test vectors.
 *  2. The platform's own `crypto.subtle.digest` — the primitive the brief
 *     names. We stream instead (see digest.ts for why), so these tests are
 *     what make that substitution safe rather than assumed.
 */
import { describe, expect, it } from "vitest";

import { HashCancelledError, formatBytes, hashBlob } from "./digest";

/** The reference implementation we are checking ourselves against. */
async function webCryptoDigest(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer]);
}

describe("known-answer vectors", () => {
  it.each([
    ["empty", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    [
      "abc",
      "abc",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ],
    [
      "test",
      "test",
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ],
    [
      "448-bit RFC 6234 vector",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("hashes %s correctly", async (_name, input, expected) => {
    const result = await hashBlob(new Blob([input]));
    expect(result.digest).toBe(expected);
    expect(result.algorithm).toBe("sha256");
  });

  it("hashes a million 'a' characters to the published vector", async () => {
    const result = await hashBlob(new Blob(["a".repeat(1_000_000)]), {
      chunkBytes: 64 * 1024,
    });
    expect(result.digest).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("agreement with crypto.subtle", () => {
  it.each([0, 1, 63, 64, 65, 1000, 4096, 100_000])(
    "matches Web Crypto for a %i-byte input",
    async (size) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const ours = await hashBlob(blobOf(bytes), { chunkBytes: 997 });
      expect(ours.digest).toBe(await webCryptoDigest(bytes));
    },
  );

  it("is unaffected by chunk size", async () => {
    const bytes = new Uint8Array(50_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;
    const expected = await webCryptoDigest(bytes);
    for (const chunkBytes of [1, 7, 64, 1023, 65_536, 1_000_000]) {
      const result = await hashBlob(blobOf(bytes), { chunkBytes });
      expect(result.digest, `chunk ${chunkBytes}`).toBe(expected);
    }
  });
});

describe("progress reporting", () => {
  it("reports monotonically and finishes at exactly 1", async () => {
    const bytes = new Uint8Array(10_000);
    const seen: number[] = [];
    await hashBlob(blobOf(bytes), {
      chunkBytes: 1000,
      onProgress: (p) => seen.push(p.fraction),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it("reports fraction 1 for an empty file rather than NaN", async () => {
    const seen: number[] = [];
    const result = await hashBlob(new Blob([]), {
      onProgress: (p) => seen.push(p.fraction),
    });
    expect(seen.every((f) => Number.isFinite(f))).toBe(true);
    expect(seen[0]).toBe(1);
    expect(result.bytesTotal).toBe(0);
  });

  it("reports byte counts that add up to the file size", async () => {
    const bytes = new Uint8Array(5000);
    let last = 0;
    const result = await hashBlob(blobOf(bytes), {
      chunkBytes: 512,
      onProgress: (p) => {
        last = p.bytesProcessed;
        expect(p.bytesTotal).toBe(5000);
      },
    });
    expect(last).toBe(5000);
    expect(result.bytesTotal).toBe(5000);
  });
});

describe("cancellation", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      hashBlob(new Blob(["anything"]), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(HashCancelledError);
  });

  it("stops partway through when aborted mid-hash", async () => {
    const bytes = new Uint8Array(200_000);
    const controller = new AbortController();
    let chunks = 0;

    await expect(
      hashBlob(blobOf(bytes), {
        chunkBytes: 1000,
        signal: controller.signal,
        onProgress: () => {
          chunks += 1;
          if (chunks === 5) controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(HashCancelledError);

    // Proves it actually stopped early rather than finishing and then throwing.
    expect(chunks).toBeLessThan(50);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [10 * 1024, "10 KB"],
    [1024 * 1024, "1.0 MB"],
    [1024 * 1024 * 1024, "1.0 GB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
