import type { Adapter } from "@sveltejs/kit";

import { adapt } from "./adapt.js";
import { createCache } from "./cache-handler.js";
import {
  normalizeEnv,
  type CreekdEnv,
  type SvelteAdapterRuntime,
} from "./manifest.js";

export interface CreekdSvelteAdapterOptions {
  /**
   * JS runtime creekd should spawn the server under.
   * Default: "bun" (faster cold start + HTTP throughput; `bun:sqlite`
   * is available for future cache work). "node" is the safe fallback.
   */
  runtime?: SvelteAdapterRuntime;
  /**
   * TCP port the server binds to. creekd's dispatch listener proxies
   * external traffic to this port.
   * Default: 3000.
   */
  port?: number;
  /**
   * Build output directory, relative to the project root. The entry
   * lives at `<out>/index.js`; client + prerendered assets sit beside
   * it for direct serving.
   * Default: "build".
   */
  out?: string;
  /**
   * Environment variables written into the creekd manifest. The adapter
   * always defaults NODE_ENV=production; user-provided values with the
   * same key override the default.
   */
  env?: CreekdEnv;
  /**
   * HTTP path the entry exposes as a liveness probe — always returns
   * 200 OK before reaching SvelteKit. Configured into the creekd
   * manifest's `health_check_path` so the supervisor probes the same
   * endpoint it spawned.
   * Default: "/_creek/health".
   */
  healthCheckPath?: string;
  /**
   * Run `builder.compress()` on client + prerendered output (gzip +
   * brotli). Disable for faster builds when an upstream CDN handles
   * compression.
   * Default: true.
   */
  precompress?: boolean;
  /**
   * Bundle the entry + SvelteKit runtime into a single file (currently
   * unimplemented — see ARCHITECTURE.md for the deployment-strategy
   * discussion). Reserved on the API surface so P1's opt-in esbuild
   * bundling can land without breaking changes.
   *
   * P0 only accepts `false`. The default `false` path requires
   * production `node_modules` on the target, exactly like
   * `@sveltejs/adapter-node` does.
   */
  bundle?: false;
}

const DEFAULT_PORT = 3000;
const DEFAULT_OUT = "build";
const DEFAULT_HEALTH = "/_creek/health";

/**
 * SvelteKit adapter that produces a creekd-ready server entry and a
 * `.creek-creekd/manifest.json` describing the supervised process.
 *
 *   // svelte.config.js
 *   import adapter from "@solcreek/svelte-adapter";
 *   export default {
 *     kit: { adapter: adapter({ runtime: "bun", port: 3000 }) }
 *   };
 *
 * `creekctl up --from .creek-creekd/manifest.json` then spawns the
 * generated entry under the chosen runtime.
 */
export default function adapter(
  options: CreekdSvelteAdapterOptions = {},
): Adapter {
  const runtime: SvelteAdapterRuntime = options.runtime ?? "bun";
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `@solcreek/svelte-adapter: port must be an integer in 1..65535, got ${port}`,
    );
  }
  const out = options.out ?? DEFAULT_OUT;
  const healthCheckPath = options.healthCheckPath ?? DEFAULT_HEALTH;
  if (!healthCheckPath.startsWith("/")) {
    throw new Error(
      `@solcreek/svelte-adapter: healthCheckPath must start with "/", got ${JSON.stringify(healthCheckPath)}`,
    );
  }
  const env = normalizeEnv(options.env);
  const precompress = options.precompress ?? true;
  if (options.bundle !== undefined && options.bundle !== false) {
    throw new Error(
      "@solcreek/svelte-adapter: bundle option is reserved for a future release; pass false (default) until then",
    );
  }

  return {
    name: "@solcreek/svelte-adapter",

    async adapt(builder) {
      await adapt(builder, {
        outDir: out,
        runtime,
        port,
        env,
        healthCheckPath,
        precompress,
      });
    },

    supports: {
      // $app/server `read()` works on both bun and node: the entry
      // wires builder.init({ read }) to read from server/<file>.
      read: () => true,
      // `instrumentation.server.js` runs before app code: adapt() asks
      // builder.instrument() to wrap our entry with a TLA shim that
      // imports the compiled instrumentation file before the real entry.
      instrumentation: () => true,
    },

    // Inject platform.cache during `vite dev` and prerender so user
    // code that calls platform.cache.cached(...) doesn't need to
    // branch on dev vs prod. The dev cache shares the same L2 dir
    // as production (default .creek/svelte-cache) so hot SSR data
    // survives dev-server restarts too.
    emulate() {
      const cache = createCache({
        dir: process.env.CREEK_SVELTE_CACHE_DIR,
        l1Entries: Number(process.env.CREEK_SVELTE_CACHE_L1) || undefined,
        inMemoryOnly: process.env.CREEK_SVELTE_CACHE_DISABLED === "1",
        driver: process.env.CREEK_SVELTE_CACHE_DRIVER as
          | "fs"
          | "bun-sqlite"
          | "auto"
          | undefined,
      });
      return {
        platform: () => ({ cache }),
      };
    },
  };
}

export type {
  CreekdSvelteManifest,
  CreekdEnv,
  SvelteAdapterRuntime,
  WriteManifestOptions,
} from "./manifest.js";
export { writeManifest } from "./manifest.js";
