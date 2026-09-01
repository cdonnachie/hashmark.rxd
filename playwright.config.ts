import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a real production build, not `next dev`: the CSP
 * differs between the two (dev needs `unsafe-eval`), and a policy that only
 * works in development is worth nothing.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // The standalone server is what production runs, so it is what the
        // tests exercise. `next start` does not serve a standalone build.
        command: "pnpm build && node .next/standalone/server.js",
        env: { PORT: "3100", HOSTNAME: "127.0.0.1" },
        url: "http://127.0.0.1:3100",
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
