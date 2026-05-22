// Copies src/entries/*.js into dist/entries/ verbatim. The entry files
// are runtime templates emitted into the user's build output — they're
// not compiled by tsc (excluded in tsconfig.json) because they target
// the *spawned* runtime (Node/Bun), not the build-time TS compiler.

import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..", "src", "entries");
const distDir = resolve(here, "..", "dist", "entries");

await mkdir(distDir, { recursive: true });
const files = await readdir(srcDir);
await Promise.all(
  files
    .filter((name) => name.endsWith(".js"))
    .map((name) => cp(join(srcDir, name), join(distDir, name))),
);

console.log(`copy-entries: copied ${files.length} entry file(s) to dist/entries/`);
