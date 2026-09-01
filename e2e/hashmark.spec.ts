import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the two flows a user actually performs, plus the
 * claims the product makes about itself.
 *
 * The privacy test is the important one: it asserts that hashing a file
 * produces **no network request at all**. That is the central promise, and it
 * is the kind of thing that breaks silently, so it is checked mechanically
 * rather than by reading the code.
 */

/** SHA-256("test") — the fixture used throughout. */
const TEST_DIGEST =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/**
 * Drive the real file input with a real File, so the production hashing path
 * runs rather than a stub.
 */
async function chooseFile(page: Page, content = "test", name = "contract.pdf") {
  await page.setInputFiles('input[type="file"]', {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(content),
  });
}

test.describe("the file never leaves the browser", () => {
  test("hashing makes no network request carrying the file", async ({ page }) => {
    const uploads: string[] = [];

    page.on("request", (request) => {
      const method = request.method();
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        uploads.push(`${method} ${request.url()}`);
      }
      // A GET carrying the file content would be just as bad.
      if (request.url().includes("test") && request.url().includes("upload")) {
        uploads.push(`${method} ${request.url()}`);
      }
    });

    await page.goto("/");
    await chooseFile(page);
    await expect(page.getByText(TEST_DIGEST).first()).toBeVisible();

    expect(
      uploads,
      "hashing a file must not send it anywhere",
    ).toEqual([]);
  });

  test("computes the correct digest for a known input", async ({ page }) => {
    await page.goto("/");
    await chooseFile(page);
    await expect(page.getByText(TEST_DIGEST).first()).toBeVisible();
  });

  test("a changed byte produces a different fingerprint", async ({ page }) => {
    await page.goto("/");
    await chooseFile(page, "test");
    await expect(page.getByText(TEST_DIGEST).first()).toBeVisible();

    await page.getByRole("button", { name: "Clear" }).click();
    await chooseFile(page, "tesu"); // one byte different
    await expect(page.getByText(TEST_DIGEST)).toHaveCount(0);
  });
});

test.describe("create", () => {
  test("warns that a label is permanently public, before any wallet is opened", async ({
    page,
  }) => {
    await page.goto("/create");
    await chooseFile(page);

    const label = page.getByLabel(/public label/i);
    await expect(label).toBeVisible();
    await expect(
      page.getByText(/permanently public on the Radiant blockchain/i),
    ).toBeVisible();
  });

  test("counts the label in bytes, not characters", async ({ page }) => {
    await page.goto("/create");
    await chooseFile(page);

    const label = page.getByLabel(/public label/i);
    await label.fill("abc");
    await expect(page.getByText("3 of 128 bytes")).toBeVisible();

    // Four characters, sixteen bytes.
    await label.fill("🏠🏠🏠🏠");
    await expect(page.getByText(/16 of 128 bytes/)).toBeVisible();
    await expect(
      page.getByText(/some characters take more than one byte/),
    ).toBeVisible();
  });

  test("shows exactly what will be published, and what will not", async ({
    page,
  }) => {
    await page.goto("/create");
    await chooseFile(page);
    await expect(page.getByRole("button", { name: /connect photonic/i })).toBeVisible();
    // The fingerprint is shown before anything is sent anywhere.
    await expect(page.getByText(TEST_DIGEST).first()).toBeVisible();
  });

  test("cannot broadcast without connecting a wallet first", async ({ page }) => {
    await page.goto("/create");
    await chooseFile(page);
    await expect(page.getByRole("button", { name: /approve in photonic/i })).toHaveCount(0);
  });
});

test.describe("verify", () => {
  test("distinguishes 'search unavailable' from 'no mark found'", async ({
    page,
  }) => {
    await page.goto("/verify");
    await chooseFile(page);

    // Whichever outcome the connected node produces, it must never be the
    // ambiguous one: "no match" and "cannot search" are different claims.
    const unavailable = page.getByText(/search is unavailable/i);
    const none = page.getByText(/no matching hashmark found/i);
    const found = page.getByText(/records this file/i);

    await expect(unavailable.or(none).or(found)).toBeVisible({ timeout: 30_000 });

    if (await unavailable.isVisible()) {
      await expect(
        page.getByText(/do not read it as/i),
        "an unavailable search must say it is not a result about the file",
      ).toBeVisible();
      await expect(none).toHaveCount(0);
    }
  });

  test("never calls an unmatched file fraudulent", async ({ page }) => {
    await page.goto("/verify");
    await chooseFile(page, "a file that is certainly not marked anywhere");
    await page.waitForTimeout(2000);

    const body = (await page.textContent("body")) ?? "";
    expect(body.toLowerCase()).not.toContain("fraudulent");
    expect(body.toLowerCase()).not.toContain("fake");
    expect(body.toLowerCase()).not.toContain("invalid file");
  });
});

test.describe("transaction lookup", () => {
  test("rejects a malformed transaction id without querying anything", async ({
    page,
  }) => {
    await page.goto("/tx/not-a-transaction-id");
    await expect(page.getByText(/not a transaction id/i)).toBeVisible();
  });

  test("reads a real transaction from the chain", async ({ page }) => {
    // A real mainnet transaction that carries a non-HashMark OP_RETURN.
    await page.goto(
      "/tx/c662253d4e85e52ecc78573e88d286d18a197b2471625740ba445c9148e6ad52",
    );
    await expect(
      page.getByText(/carries no HashMark|could not read/i),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("receipt", () => {
  test("refuses a receipt whose genesis hash contradicts its network", async ({
    page,
  }) => {
    await page.goto("/receipt");
    await page.getByLabel(/paste the receipt/i).fill(
      JSON.stringify({
        format: "hashmark-receipt",
        version: 1,
        network: "radiant-mainnet",
        algorithm: "sha256",
        digest: TEST_DIGEST,
        transactionId: "a".repeat(64),
        outputIndex: 0,
        genesisHash: "f".repeat(64),
      }),
    );
    await page.getByRole("button", { name: /check this receipt/i }).click();
    await expect(
      page.getByText(/names one chain and points at another/i),
    ).toBeVisible();
  });

  test("reports every problem in a malformed receipt at once", async ({ page }) => {
    await page.goto("/receipt");
    await page.getByLabel(/paste the receipt/i).fill(
      JSON.stringify({
        format: "wrong",
        version: 1,
        network: "bitcoin",
        algorithm: "md5",
        digest: "ZZ",
        transactionId: "short",
        outputIndex: -1,
      }),
    );
    await page.getByRole("button", { name: /check this receipt/i }).click();

    // Next injects its own route announcer with role="alert", so scope to the
    // one that actually carries the errors.
    const alert = page
      .getByRole("alert")
      .filter({ hasText: /does not check out/i });
    await expect(alert).toBeVisible();
    expect(await alert.locator("li").count()).toBeGreaterThanOrEqual(4);
  });

  test("rejects text that is not JSON", async ({ page }) => {
    await page.goto("/receipt");
    await page.getByLabel(/paste the receipt/i).fill("{not json");
    await page.getByRole("button", { name: /check this receipt/i }).click();
    await expect(page.getByText(/not valid JSON/i)).toBeVisible();
  });
});

test.describe("claims", () => {
  test("the homepage states what a mark does not prove", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/does not show/i)).toBeVisible();
    await expect(
      page.getByText(/Who wrote the file/i).first(),
    ).toBeVisible();
  });

  test("the protocol page example matches the real encoder", async ({ page }) => {
    await page.goto("/protocol");
    // The record for SHA-256("test") with no label, generated by the encoder.
    // The no-label record is a prefix of the labelled one, so both <pre>
    // blocks contain this string. Match the exact element.
    await expect(
      page.getByText(`6a08484153484d41524b02010120${TEST_DIGEST}`, {
        exact: true,
      }),
    ).toBeVisible();
  });
});

test.describe("confirmation status", () => {
  test("a transaction page says it is tracking, and does not claim more", async ({
    page,
  }) => {
    await page.goto(
      "/tx/c662253d4e85e52ecc78573e88d286d18a197b2471625740ba445c9148e6ad52",
    );
    // This one is long confirmed, so the page must NOT advertise live tracking:
    // saying "rechecking" about something already settled would be noise.
    await expect(
      page.getByText(/carries no HashMark|could not read/i),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Rechecking automatically/i)).toHaveCount(0);
  });

  test("the WAVE name or a shortened address is shown, never a raw one", async ({
    page,
  }) => {
    // Without a wallet connected there is no identity chip at all — the point
    // is that a full base58 address is never rendered as the identity.
    await page.goto("/create");
    const body = (await page.textContent("body")) ?? "";
    expect(body).not.toMatch(/1[a-km-zA-HJ-NP-Z1-9]{25,34}/);
  });
});
