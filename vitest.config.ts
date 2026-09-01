import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@hashmark/protocol": new URL(
        "./packages/protocol/src/index.ts",
        import.meta.url,
      ).pathname,
      // `server-only` throws on import outside a React Server Component, which
      // is exactly its job — but it would fail every unit test that touches a
      // server module. Resolve it to the package's own no-op build instead.
      "server-only": new URL(
        "./node_modules/server-only/empty.js",
        import.meta.url,
      ).pathname,
      // Mirrors the "@/*" path alias in tsconfig.json.
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
