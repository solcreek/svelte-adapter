// Optional esbuild bundling of the generated server entry.
//
// Goal: a self-contained `build/index.js` so the deploy artifact is one
// file (and a few static dirs) instead of a 100 MB node_modules tree.
//
// What's bundled vs left external:
// - INLINE: ./manifest.js (pure data), ./runtime.js + ./cache-handler.js
//   + ./cache-handler-sqlite.js (our runtime shim), @sveltejs/kit/node,
//   @sveltejs/kit/node/polyfills. The kit/node helpers are small and
//   only used by the entry — inlining lets us drop node_modules on target.
// - EXTERNAL: ./server/* — the kit Server class dynamically imports
//   sibling route modules at runtime (`await import('./<route>.js')`),
//   so the Server module MUST resolve relative to serverDir on disk,
//   not relative to our bundled entry. Inlining would silently break
//   route loading.
// - EXTERNAL: bun:sqlite — Bun built-in, resolved at runtime.
// - EXTERNAL: node:* — Node built-ins (esbuild auto-handles, but the
//   explicit list documents intent).
//
// Native modules (better-sqlite3, sharp, @node-rs/*, etc.) live in the
// kit server bundle that writeServer() produced — Vite already decided
// what to bundle there. We don't try to second-guess Vite.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { build, type BuildOptions } from "esbuild";

import type { SvelteAdapterRuntime } from "./manifest.js";

export interface BundleEntryOptions {
  /** Path to the entry to bundle (will be overwritten in place). */
  entry: string;
  /** Output file (typically the same path as `entry`). */
  outFile: string;
  /** Runtime — informs target version + Bun-specific externals. */
  runtime: SvelteAdapterRuntime;
  /**
   * Absolute path to the directory esbuild resolves bare specifiers
   * from. Typically the user's project root — that's where
   * `@sveltejs/kit` lives in node_modules during build. The build
   * output directory has no node_modules; resolving relative to it
   * would fail with "Could not resolve '@sveltejs/kit/node'".
   */
  absWorkingDir: string;
  /**
   * Inline source maps in the bundle. Defaults to true so production
   * stack traces stay readable; flip off only when the artifact-size
   * cost is genuinely the bottleneck.
   */
  sourcemap?: boolean;
}

/**
 * The Server module is loaded by the entry as `./server/index.js`.
 * Kit's Server class dynamically imports route modules at runtime
 * relative to its own location — inlining the Server module would
 * break those imports. Always external.
 */
const SERVER_MODULE_EXTERNALS = ["./server/*", "./server/index.js"];

/**
 * Bun's bun:sqlite is a built-in module (not on npm). Our cache-handler-
 * sqlite imports it lazily; esbuild needs an explicit external so the
 * dynamic import survives.
 */
const BUN_BUILTINS = ["bun:sqlite"];

export async function bundleEntry(opts: BundleEntryOptions): Promise<void> {
  const { entry, outFile, runtime, absWorkingDir, sourcemap = true } = opts;

  // Read the source first because esbuild writes outFile after reading
  // entry — if entry === outFile (the common case), the read is safe
  // because esbuild buffers the file before writing back. Documented
  // behaviour, not racy.
  const buildOptions: BuildOptions = {
    entryPoints: [entry],
    outfile: outFile,
    absWorkingDir,
    bundle: true,
    platform: "node",
    format: "esm",
    // Node 20+ has TLA, native fetch, structuredClone — matches the
    // floor adapter-node requires for kit 2.x.
    target: runtime === "bun" ? "esnext" : "node20",
    sourcemap: sourcemap ? "inline" : false,
    // Without this, esbuild can leave dynamic `require()` shims that
    // crash under pure-ESM Node runtime.
    legalComments: "none",
    minify: false,
    treeShaking: true,
    external: [...SERVER_MODULE_EXTERNALS, ...BUN_BUILTINS],
    // esbuild auto-treats node:* as external on platform=node, but
    // some imports use the unprefixed form ("path"); platform=node
    // handles those too.
    logLevel: "silent",
    allowOverwrite: true,
  };

  const result = await build(buildOptions);
  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => e.text).join("\n");
    throw new Error(`[@solcreek/svelte-adapter] esbuild failed:\n${msg}`);
  }

  // Sanity check: outFile must exist and be non-empty.
  const stat = await fs.stat(outFile);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(
      `[@solcreek/svelte-adapter] esbuild produced empty or missing output: ${outFile}`,
    );
  }
}

/**
 * Files that adapt() previously copied next to the entry for the
 * unbundled runtime. After bundling they're inlined into the entry
 * and the source copies become dead weight — remove them so the
 * deploy artifact reflects the new shape honestly.
 */
export const RUNTIME_FILES_TO_REMOVE_AFTER_BUNDLE = [
  "runtime.js",
  "cache-handler.js",
  "cache-handler-sqlite.js",
] as const;

export async function removeRuntimeFiles(outDir: string): Promise<void> {
  await Promise.all(
    RUNTIME_FILES_TO_REMOVE_AFTER_BUNDLE.map((f) =>
      fs.rm(path.join(outDir, f), { force: true }),
    ),
  );
}
