import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { writeManifest, type SvelteAdapterRuntime } from "./manifest.js";

// `Builder` ships with @sveltejs/kit but only as a type; the adapter is
// invoked by SvelteKit which hands us the live instance, so importing
// the type is enough.
type Builder = import("@sveltejs/kit").Builder;

const CREEKD_MANIFEST_DIR = ".creek-creekd";
const DEFAULT_BUILD_DIR = "build";
const DEFAULT_HEALTH_PATH = "/_creek/health";

export interface AdaptOptions {
  outDir: string;
  runtime: SvelteAdapterRuntime;
  port: number;
  env: string[];
  healthCheckPath: string;
  precompress: boolean;
}

const ENTRY_FILES: Record<SvelteAdapterRuntime, string> = {
  node: "node.js",
  bun: "bun.js",
};

function entriesDir(): string {
  // Resolve to dist/entries/ alongside the compiled adapt.js. The build
  // script copies src/entries/*.js into dist/entries/ verbatim — the
  // template files are not compiled by tsc.
  return fileURLToPath(new URL("./entries/", import.meta.url));
}

const RUNTIME_FILES = ["runtime.js", "cache-handler.js"] as const;

// Compiled runtime modules live next to adapt.js once tsc has run.
// We resolve relative to import.meta.url so this works whether adapt
// is invoked from dist/ (production) or src/ via vitest (unit tests
// run `pnpm build` first, so dist exists).
function runtimeSourceDir(): string | null {
  const here = fileURLToPath(new URL("./", import.meta.url));
  const candidates = [
    here,
    path.join(here, "..", "dist"),
  ];
  for (const candidate of candidates) {
    if (RUNTIME_FILES.every((f) => existsSync(path.join(candidate, f)))) {
      return candidate;
    }
  }
  return null;
}

async function copyRuntimeModules(out: string, log: Builder["log"]): Promise<void> {
  const src = runtimeSourceDir();
  if (!src) {
    log.warn(
      "[@solcreek/svelte-adapter] runtime modules not found — was `pnpm build` run? platform.cache will be unavailable in the build output.",
    );
    return;
  }
  for (const f of RUNTIME_FILES) {
    await fs.copyFile(path.join(src, f), path.join(out, f));
  }
}

async function renderEntry(
  runtime: SvelteAdapterRuntime,
  port: number,
  healthCheckPath: string,
): Promise<string> {
  const templatePath = path.join(entriesDir(), ENTRY_FILES[runtime]);
  const template = await fs.readFile(templatePath, "utf8");

  // Replace placeholder constants. JSON.stringify keeps strings quoted
  // and escapes anything weird in healthCheckPath.
  return template
    .replace(/__CREEK_PORT__/g, String(port))
    .replace(/__CREEK_HEALTH__/g, JSON.stringify(healthCheckPath));
}

export async function adapt(
  builder: Builder,
  opts: AdaptOptions,
): Promise<void> {
  const out = path.resolve(opts.outDir);
  const projectDir = process.cwd();

  builder.log.minor(`Cleaning ${path.relative(projectDir, out) || out}`);
  builder.rimraf(out);
  builder.mkdirp(out);

  const clientDir = path.join(out, "client");
  const serverDir = path.join(out, "server");
  const prerenderedDir = path.join(out, "prerendered");

  builder.log.minor("Writing client assets");
  builder.writeClient(clientDir);

  builder.log.minor("Writing server bundle");
  builder.writeServer(serverDir);

  builder.log.minor("Writing prerendered pages");
  builder.writePrerendered(prerenderedDir);

  // $env/dynamic/public needs a build-time module so the values land in
  // the client bundle at the right place. adapter-node calls this from
  // adapt() — skipping it makes $env/dynamic/public quietly empty in
  // production builds.
  builder.log.minor("Generating $env modules");
  builder.generateEnvModule();

  // manifest.js sits at the build root and imports server modules via
  // ./server/. Matches the layout adapter-node uses so the entry can
  // stay a tiny shim.
  const manifestSource =
    `export const manifest = ${builder.generateManifest({ relativePath: "./server" })};\n` +
    `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n`;
  await fs.writeFile(path.join(out, "manifest.js"), manifestSource);

  builder.log.minor(`Generating ${opts.runtime} entry`);
  const entrySource = await renderEntry(
    opts.runtime,
    opts.port,
    opts.healthCheckPath,
  );
  await fs.writeFile(path.join(out, "index.js"), entrySource);

  // The entry imports from "./runtime.js" — make those files available
  // next to it so the build output runs without @solcreek/* in
  // node_modules on target.
  await copyRuntimeModules(out, builder.log);

  if (opts.precompress) {
    builder.log.minor("Compressing client + prerendered assets");
    await Promise.all([
      builder.compress(clientDir),
      builder.compress(prerenderedDir),
    ]);
  }

  const entrypoint = path.relative(projectDir, path.join(out, "index.js"));
  const serveDirs = [clientDir, prerenderedDir].map((dir) =>
    path.relative(projectDir, dir),
  );

  await writeManifest({
    outputDir: path.join(projectDir, CREEKD_MANIFEST_DIR),
    buildId: timestampBuildId(),
    runtime: opts.runtime,
    entrypoint,
    port: opts.port,
    env: opts.env,
    healthCheckPath: opts.healthCheckPath,
    serveDirs,
    hasPrerender: builder.prerendered.paths.length > 0,
  });

  builder.log.success(
    `@solcreek/svelte-adapter: ${opts.runtime} entry at ${entrypoint} (port ${opts.port})`,
  );
}

function timestampBuildId(): string {
  // No SvelteKit equivalent of Next's buildId; the timestamp is enough
  // for cache-busting / release identification.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export const __test__ = {
  DEFAULT_BUILD_DIR,
  DEFAULT_HEALTH_PATH,
};
