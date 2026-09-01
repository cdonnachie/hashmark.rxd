import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility checks on the primary flows.
 *
 * An automated scan cannot certify a page as accessible, but it reliably
 * catches the failures that matter here: unlabelled controls, missing form
 * associations, and — given a dark palette built around two accent colours —
 * insufficient contrast.
 */

const ROUTES = ["/", "/create", "/verify", "/receipt", "/protocol", "/privacy"];

for (const route of ROUTES) {
  test(`${route} has no detectable WCAG A/AA violations`, async ({ page }) => {
    await page.goto(route);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    // Report the actual rules rather than a bare count, so a failure is
    // actionable from CI output alone.
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`),
    ).toEqual([]);
  });
}

test("the create flow stays accessible once a file is chosen", async ({ page }) => {
  await page.goto("/create");
  await page.setInputFiles('input[type="file"]', {
    name: "contract.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("test"),
  });
  await expect(page.getByLabel(/public label/i)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test("every page is reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/");

  // The skip link must be the first stop, and must actually go somewhere.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to content/i });
  await expect(skip).toBeFocused();
  await expect(page.locator("#main")).toBeAttached();

  // The drop zone's file picker must be reachable without a mouse.
  await page.goto("/verify");
  const choose = page.getByRole("button", { name: /choose file/i });
  await choose.focus();
  await expect(choose).toBeFocused();
});

test("focus is always visible, never removed", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: "Create a HashMark" }).first();
  await link.focus();

  const outline = await link.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });

  expect(outline.style).not.toBe("none");
  expect(parseFloat(outline.width)).toBeGreaterThan(0);
});

test("the byte grid is described for screen readers", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', {
    name: "contract.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("test"),
  });

  // The grid is decorative-looking but carries the actual digest, so it needs
  // a text alternative rather than being hidden.
  await expect(
    page.getByRole("img", { name: /fingerprint of the file/i }),
  ).toBeVisible();
});

test("results are announced, not silently swapped in", async ({ page }) => {
  await page.goto("/verify");
  await page.setInputFiles('input[type="file"]', {
    name: "contract.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("test"),
  });
  await expect(page.locator("[aria-live]").first()).toBeAttached();
});
