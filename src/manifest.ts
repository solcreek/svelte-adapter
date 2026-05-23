import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
  isCreekdDeployManifest,
  type CreekdDeployManifest,
  type CreekdRuntime,
} from "@solcreek/creekd-manifest";

const require = createRequire(import.meta.url);
const adapterPackage = require("../package.json") as {
  name?: string;
  version?: string;
};

export type SvelteAdapterRuntime = Extract<CreekdRuntime, "bun" | "node">;

export type CreekdEnv =
  | string[]
  | Record<string, string | number | boolean>;

/**
 * Manifest written to `.creek-creekd/manifest.json` after a successful
 * SvelteKit build. creekctl `--from <manifest>` reads it to spawn the
 * supervised process. The process fields come from adapter-core so the
 * adapter and creekd stay aligned; the rest is informational metadata.
 */
export type CreekdSvelteManifest = CreekdDeployManifest & {
  framework: "sveltekit";
  adapter: {
    name: string;
    version: string;
  };
  runtime: SvelteAdapterRuntime;
  serveDirs: string[];
};

export interface WriteManifestOptions {
  outputDir: string;
  buildId: string;
  runtime: SvelteAdapterRuntime;
  entrypoint: string;
  port: number;
  env: string[];
  healthCheckPath?: string;
  serveDirs: string[];
  hasPrerender: boolean;
}

export async function writeManifest(opts: WriteManifestOptions): Promise<void> {
  const manifest: CreekdSvelteManifest = {
    version: 1,
    framework: "sveltekit",
    target: "creekd",
    buildId: opts.buildId,
    adapter: {
      name: adapterPackage.name ?? "@solcreek/svelte-adapter",
      version: adapterPackage.version ?? "0.0.0",
    },
    hasPrerender: opts.hasPrerender,
    runtime: opts.runtime,
    entrypoint: opts.entrypoint,
    port: opts.port,
    env: opts.env.length > 0 ? opts.env : undefined,
    health_check_path: opts.healthCheckPath,
    serveDirs: opts.serveDirs,
  };

  if (!isCreekdDeployManifest(manifest)) {
    throw new Error("@solcreek/svelte-adapter: generated invalid creekd manifest");
  }

  await fs.mkdir(opts.outputDir, { recursive: true });
  await fs.writeFile(
    path.join(opts.outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export function normalizeEnv(env: CreekdEnv | undefined): string[] {
  const entries = new Map<string, string>();
  entries.set("NODE_ENV", "production");

  if (Array.isArray(env)) {
    for (const item of env) {
      const separator = item.indexOf("=");
      if (separator <= 0) {
        throw new Error(
          `@solcreek/svelte-adapter: env entries must be KEY=VALUE strings, got ${JSON.stringify(item)}`,
        );
      }
      entries.set(item.slice(0, separator), item.slice(separator + 1));
    }
  } else if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (!key) {
        throw new Error("@solcreek/svelte-adapter: env object keys must be non-empty");
      }
      entries.set(key, String(value));
    }
  }

  return [...entries].map(([key, value]) => `${key}=${value}`);
}
