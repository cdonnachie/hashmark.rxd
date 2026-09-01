/**
 * The digest index client.
 *
 * One property matters more than the rest and is tested from several angles:
 * **a failing index must never look like an empty result.** "Nothing found" is
 * a claim about someone's file; "we could not search" is a claim about us, and
 * a timeout, a 500 or a garbled body must produce the second one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DIGEST = "a".repeat(64);
const TXID = "b".repeat(64);

/**
 * Re-import the module so it re-reads `HASHMARK_INDEX_URL` at load time.
 *
 * `verify` is re-imported from the same fresh graph and handed back with it:
 * after `resetModules` the error class from a stale import is a different
 * class, and `instanceof` would quietly fail.
 */
async function loadIndex(url: string | undefined) {
  vi.resetModules();
  vi.stubEnv("HASHMARK_INDEX_URL", url ?? "");
  const [index, verify] = await Promise.all([
    import("./hashmark-index"),
    import("./verify"),
  ]);
  return { ...index, HashMarkLookupUnavailable: verify.HashMarkLookupUnavailable };
}

function respondWith(body: unknown, init: ResponseInit = {}) {
  const fetchMock = vi.fn<(url: string | URL | Request) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseIndexHits", () => {
  it("keeps well-formed hits and normalises the txid", async () => {
    const { parseIndexHits } = await loadIndex("http://index.invalid");
    expect(
      parseIndexHits([
        { txid: TXID.toUpperCase(), output_index: 2, height: 459_000 },
      ]),
    ).toEqual([{ txid: TXID, outputIndex: 2, height: 459_000 }]);
  });

  it("drops hits with no usable transaction id", async () => {
    const { parseIndexHits } = await loadIndex("http://index.invalid");
    expect(
      parseIndexHits([
        { txid: "not-a-txid", output_index: 0 },
        { output_index: 0 },
        null,
        "nonsense",
        { txid: TXID },
      ]),
    ).toEqual([{ txid: TXID, outputIndex: 0, height: 0 }]);
  });

  it("treats a non-array body as an unavailable index, not an empty result", async () => {
    const { parseIndexHits, HashMarkLookupUnavailable } = await loadIndex(
      "http://index.invalid",
    );
    expect(() => parseIndexHits({ error: "boom" })).toThrow(
      HashMarkLookupUnavailable,
    );
  });
});

describe("lookupDigest", () => {
  it("asks the index for the full digest and nothing less", async () => {
    const fetchMock = respondWith([]);
    const { lookupDigest } = await loadIndex("http://index.invalid/");

    await lookupDigest(DIGEST, { limit: 5 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    // The trailing slash on the configured base must not double up.
    expect(url).toBe(
      `http://index.invalid/hashmark/${DIGEST}?algorithm=sha256&limit=5`,
    );
  });

  it("refuses a digest that is not 64 lowercase hex characters", async () => {
    respondWith([]);
    const { lookupDigest } = await loadIndex("http://index.invalid");
    // A partial digest must never reach the index: prefix search is how an
    // index gets enumerated.
    await expect(lookupDigest("abc")).rejects.toThrow(/64 lowercase hex/);
  });

  it("returns an empty list when the digest was never marked", async () => {
    respondWith([]);
    const { lookupDigest } = await loadIndex("http://index.invalid");
    await expect(lookupDigest(DIGEST)).resolves.toEqual([]);
  });

  it.each([
    ["no index is configured", undefined, [] as unknown, { status: 200 }],
    ["the index errors", "http://index.invalid", {}, { status: 500 }],
    ["the digest is rejected upstream", "http://index.invalid", {}, { status: 422 }],
  ])("reports unavailable when %s", async (_name, url, body, init) => {
    respondWith(body, init as ResponseInit);
    const { lookupDigest, HashMarkLookupUnavailable } = await loadIndex(
      url as string | undefined,
    );
    await expect(lookupDigest(DIGEST)).rejects.toThrow(
      HashMarkLookupUnavailable,
    );
  });

  it("reports unavailable when the index cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 10.0.0.5:8000");
      }),
    );
    const { lookupDigest, HashMarkLookupUnavailable } = await loadIndex(
      "http://index.invalid",
    );

    const error = await lookupDigest(DIGEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HashMarkLookupUnavailable);
    // The upstream address must not leak into a message we show a visitor.
    expect((error as Error).message).not.toContain("10.0.0.5");
  });
});

describe("indexStatus", () => {
  it("reads the backfill fields RXinDexer reports", async () => {
    respondWith({
      enabled: true,
      backfill_complete: false,
      backfill_target_height: 459_475,
      backfill_next_height: 292_400,
    });
    const { indexStatus } = await loadIndex("http://index.invalid");

    await expect(indexStatus()).resolves.toEqual({
      enabled: true,
      backfillComplete: false,
      backfillNextHeight: 292_400,
      backfillTargetHeight: 459_475,
    });
  });

  it("reads a finished backfill, which reports no next height", async () => {
    respondWith({
      enabled: true,
      backfill_complete: true,
      backfill_target_height: 459_475,
      backfill_next_height: null,
      pending_rows: 0,
      algorithms: { sha256: 1 },
      protocol_version: 1,
    });
    const { indexStatus } = await loadIndex("http://index.invalid");

    await expect(indexStatus()).resolves.toEqual({
      enabled: true,
      backfillComplete: true,
      backfillNextHeight: null,
      backfillTargetHeight: 459_475,
    });
  });

  it("does not assume a backfill is complete when the index does not say", async () => {
    respondWith({ enabled: true });
    const { indexStatus } = await loadIndex("http://index.invalid");
    await expect(indexStatus()).resolves.toMatchObject({
      enabled: true,
      backfillComplete: false,
    });
  });

  it("returns null rather than throwing when status cannot be read", async () => {
    respondWith({}, { status: 503 });
    const { indexStatus } = await loadIndex("http://index.invalid");
    await expect(indexStatus()).resolves.toBeNull();
  });
});
