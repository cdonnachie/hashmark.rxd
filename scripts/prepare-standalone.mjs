/**
 * Complete the standalone build.
 *
 * `output: "standalone"` emits a self-contained server under
 * `.next/standalone`, but Next deliberately leaves the static assets out of it:
 * they are expected to be served by a CDN. When the Node server is the only
 * thing serving the site — which is the case behind nginx — they have to be
 * copied in, or every page loads without CSS or JavaScript.
 *
 * Run automatically as part of `pnpm build`.
 */
import { cp, access } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(standalone))) {
  console.error(
    'No .next/standalone directory. Is `output: "standalone"` still set in next.config.ts?',
  );
  process.exit(1);
}

await cp(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
});

if (await exists(join(root, "public"))) {
  await cp(join(root, "public"), join(standalone, "public"), { recursive: true });
}

console.log("Standalone build ready: node .next/standalone/server.js");
