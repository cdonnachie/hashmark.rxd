/**
 * Add explicit `.js` extensions to relative imports in the emitted output.
 *
 * The source deliberately uses extensionless relative imports, because that is
 * what the bundlers this repo actually develops against (Turbopack, Vite) and
 * the `@hashmark/protocol` tsconfig path alias resolve. Node's ESM loader, on
 * the other hand, requires the extension — so a package published straight from
 * `tsc` output would fail to import outside a bundler.
 *
 * TypeScript will not rewrite specifiers on emit, so this closes the gap. It is
 * a deliberately small, exact transform: only relative specifiers, only where
 * an extension is absent.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." with
// a leading slash, which every fs call then rejects.
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

// `from "./x"` / `from '../y'` — relative only, no extension already present.
const SPECIFIER = /(\bfrom\s*["'])(\.\.?\/[^"']*?)(["'])/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

let patched = 0;

for await (const file of walk(DIST)) {
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;

  const source = await readFile(file, "utf8");
  const output = source.replace(SPECIFIER, (match, open, specifier, close) =>
    /\.[a-zA-Z0-9]+$/.test(specifier)
      ? match
      : `${open}${specifier}.js${close}`,
  );

  if (output !== source) {
    await writeFile(file, output, "utf8");
    patched += 1;
  }
}

console.log(`ESM extensions added in ${patched} emitted file(s).`);
