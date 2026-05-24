# @solcreek/svelte-adapter

SvelteKit deployment adapter for [`@solcreek/creekd`](https://github.com/solcreek/creekd) self-host. Produces a runnable HTTP server entry + a `.creek-creekd/manifest.json` describing the supervised process, so `creekctl up --from .creek-creekd/manifest.json` knows exactly what to spawn.

Pairs creekd's neutral process supervisor (cgroups, namespaces, dispatch, health probes) with SvelteKit-shaped defaults: prerendered fast-path, hashed-asset immutable caching, `X-Forwarded-*` aware URL rebuilding, `sveltekit:shutdown` graceful drain.

```
@sveltejs/adapter-node    /bench/slow      ⏤  191 req/s  ·  52 ms p50
@solcreek/svelte-adapter  /bench/slow      ⏤  191 req/s  ·  52 ms p50   (zero overhead)
@solcreek/svelte-adapter  /bench/cached    ⏤  11,680 req/s · 0.67 ms p50  ← platform.cache
```

`pnpm bench` reproduces these numbers on your machine. The cached path uses `event.platform.cache` (L1 LRU + L2 filesystem, survives restart, tag invalidation) — see [Benchmark](#benchmark-vs-sveltejsadapter-node) and [`platform.cache`](#platformcache--persistent-kv-for-sveltekit-the-differentiator-vs-adapter-node).

## Status

Pre-1.0, targets SvelteKit ≥ 2.0. The adapter is feature-complete vs `@sveltejs/adapter-node` (same env-var surface, same `sveltekit:shutdown` contract, same `node_modules`-on-target deployment model) and adds `platform.cache` as its differentiator. Self-host, Bun runtime, and `creekctl` integration are first-class.

## Install

```bash
pnpm add -D @solcreek/svelte-adapter
```

## Usage

```js
// svelte.config.js
import adapter from "@solcreek/svelte-adapter";

export default {
  kit: {
    adapter: adapter({
      runtime: "bun",   // default; "node" is the safe fallback
      port: 3000,
      // healthCheckPath: "/_creek/health",   // default
      // precompress: true,                   // default
      // env: { FEATURE_X: "1" },             // additive over NODE_ENV=production
    }),
  },
};
```

After `pnpm build`:

- `build/index.js` — the runtime entry (Node or Bun)
- `build/server/`, `build/client/`, `build/prerendered/` — SvelteKit output
- `.creek-creekd/manifest.json` — what creekd reads to spawn the process

Spawn under creekd:

```bash
creekctl up --from .creek-creekd/manifest.json
```

## Options

| Option | Default | Notes |
|---|---|---|
| `runtime` | `"bun"` | `"bun"` \| `"node"`. Recorded in the manifest so creekd uses the right executable. |
| `port` | `3000` | TCP port the entry binds to. Overridable at spawn via `PORT`. |
| `out` | `"build"` | Output directory. |
| `env` | `{ NODE_ENV: "production" }` | Written into the creekd manifest; `KEY=VALUE` strings or an object. NODE_ENV defaults to `production` unless overridden. |
| `healthCheckPath` | `"/_creek/health"` | Always 200 before SvelteKit sees the request. Also recorded in the manifest as creekd's liveness probe. |
| `precompress` | `true` | gzip + brotli on `client/` and `prerendered/`. |
| `bundle` | `false` | Reserved for P1 — opt-in esbuild bundling. P0 only accepts `false`. See [Deployment](#deployment). |

## `platform.cache` — persistent KV for SvelteKit (the differentiator vs `adapter-node`)

SvelteKit doesn't ship a first-class ISR or cache-handler primitive — there's no equivalent of Next.js's `cacheHandler`. This adapter exposes a small persistent cache on `event.platform.cache` so user code can do tag-invalidated, restart-surviving caching without bolting on Redis just to self-host.

```ts
// src/routes/+page.server.ts
export async function load({ platform }) {
  return {
    feed: await platform.cache.cached(
      "homepage-feed:v1",
      { revalidate: 60, tags: ["feed"] },
      async () => {
        // expensive query — runs once per minute (or after invalidateTag)
        return await db.feed.recent();
      },
    ),
  };
}

// src/routes/api/publish/+server.ts
export async function POST({ platform, request }) {
  await db.posts.insert(await request.json());
  await platform.cache.invalidateTag("feed");
  return new Response(null, { status: 204 });
}
```

**Implementation:**
- **L1**: in-process LRU (insertion-order Map; default 2048 entries)
- **L2**: pluggable driver. `bun-sqlite` on Bun (single `cache.sqlite` with WAL); `fs` on Node (one JSON per entry under `$CREEK_SVELTE_CACHE_DIR/entries/<hash[0:2]>/<hash>.json`, atomic via tmp+rename). `auto` (default) picks the right one at startup.
- **Tags**: per-tag invalidation sentinel `{ invalidatedAt }`; entries are stale if any of their tags was invalidated after `entry.createdAt`. Stored as a `tags` row in sqlite, as `tags/<safe>.json` in fs.
- **SWR**: `cached()` returns stale data while a background loader refreshes; coalesces concurrent misses for the same key
- **Dev parity**: `adapter.emulate()` provides the same cache in `vite dev` and prerender via `event.platform.cache` — no `if (import.meta.env.DEV)` branches needed
- **Graceful shutdown**: cache is closed (in-flight writes flushed; sqlite WAL checkpointed) after `sveltekit:shutdown` listeners run

**L2 driver microbench** (1000 set + 1000 cold-L2 get, Bun 1.3, M-series macOS):

| Driver | set/s | get/s |
|---|---:|---:|
| `fs` | 4,573 | 31,984 |
| `bun-sqlite` | **28,082** | **232,518** |

~6× write throughput, ~7× read throughput. The fs driver isn't slow in absolute terms — sqlite just avoids the per-entry `mkdir`/`tmp`/`rename` syscall trio and WAL gives durable writes without per-write fsync. The fs driver remains the only choice on Node.

### Cache env vars

| Var | Default | Effect |
|---|---|---|
| `CREEK_SVELTE_CACHE_DIR` | `.creek/svelte-cache` (relative to cwd) | L2 directory |
| `CREEK_SVELTE_CACHE_L1` | `2048` | L1 LRU capacity (entries) |
| `CREEK_SVELTE_CACHE_DRIVER` | `auto` | Force a specific L2 driver: `fs`, `bun-sqlite`, or `auto`. Pinning to `fs` on Bun is the migration escape hatch if a sqlite issue surfaces. |
| `CREEK_SVELTE_CACHE_DISABLED` | unset | When `=1`, skip L2 entirely (in-memory only) |

### App.Platform typing

To get autocomplete on `event.platform.cache`, declare it in your project's `src/app.d.ts`:

```ts
import type { CreekdSvelteCache } from "@solcreek/svelte-adapter/runtime";

declare global {
  namespace App {
    interface Platform {
      cache: CreekdSvelteCache;
    }
  }
}
export {};
```

## Runtime environment variables

The generated entry honours the same env vars as `@sveltejs/adapter-node`, so existing Svelte deployment knowledge transfers directly:

| Var | Default | Effect |
|---|---|---|
| `PORT` | from `adapter({ port })` | TCP port |
| `HOST` | `0.0.0.0` | bind address |
| `ORIGIN` | unset | overrides the request URL's origin entirely (preferred when proxy headers can't be trusted) |
| `PROTOCOL_HEADER` | unset | header to read for `event.url.protocol` (typically `x-forwarded-proto`) |
| `HOST_HEADER` | unset | header to read for `event.url.host` (typically `x-forwarded-host`) |
| `PORT_HEADER` | unset | header to read for port |
| `ADDRESS_HEADER` | unset | header to read for `getClientAddress()` (typically `x-forwarded-for`) |
| `XFF_DEPTH` | `1` | trusted-proxy depth when parsing comma-separated forwarded-for chains |
| `BODY_SIZE_LIMIT` | `524288` (512 KB) | requests with `Content-Length` above this are rejected with 413 |
| `SHUTDOWN_TIMEOUT` | `30` (seconds) | grace window after SIGTERM before forcing exit |

### Graceful shutdown

The entry emits the `sveltekit:shutdown` event on `SIGINT` / `SIGTERM` with the signal name as the reason; listeners may return promises and they are all awaited before the socket is closed. Use this to close DB pools, flush queues, etc.

```ts
// instrumentation.server.ts (or any module loaded at startup)
process.on("sveltekit:shutdown", async (reason) => {
  await db.end();
});
```

### SPA / catch-all fallback

For SPA-mode apps (everything client-rendered) or for a styled custom 404 page, pass a `fallback` filename. The adapter calls `builder.generateFallback()` to write the SvelteKit root layout as a static HTML shell into the prerendered output, and the server entry serves that file on any SSR 404:

```ts
// svelte.config.js
import adapter from "@solcreek/svelte-adapter";
export default {
  kit: { adapter: adapter({ fallback: "200.html" }) },
};
```

Status code follows the filename: `404.html` → 404, anything else (`200.html`, `index.html`, …) → 200. Prerendered hits and successful SSR responses still win — fallback only fires when SSR returns 404.

### Instrumentation (SvelteKit 2.31+)

If you provide `src/instrumentation.server.ts`, this adapter wraps the generated entry so the instrumentation module loads **before** any application code — required for OpenTelemetry auto-instrumentation, logger init, DB pool warm-up, etc. No configuration needed; enable the kit feature in `svelte.config.js`:

```ts
// svelte.config.js
export default {
  kit: {
    experimental: { instrumentation: { server: true } },
    adapter: adapter(),
  },
};
```

```ts
// src/instrumentation.server.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] });
sdk.start();
```

Caveats inherited from kit's `builder.instrument()`: "live exports" do not work (none in this adapter's entry), and OTel auto-instrumentation needs top-level-await runtime support (Node 14.8+ / Bun — always satisfied here).

## Benchmark vs `@sveltejs/adapter-node`

Same minimal SvelteKit fixture, same Node version, same hardware, 2000 requests at concurrency 10. `/bench/slow` simulates a 50 ms backend dependency; `/bench/cached` wraps it in `platform.cache.cached`.

| Adapter | Endpoint | req/s | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---:|---:|---:|---:|
| `@sveltejs/adapter-node` | `/bench/slow` | 191 | 52.3 | 53.8 | 55.4 |
| `@solcreek/svelte-adapter` | `/bench/slow` | 191 | 52.2 | 53.3 | 53.9 |
| `@solcreek/svelte-adapter` | `/bench/cached` | **11,680** | **0.67** | 2.1 | 2.8 |

Two takeaways:

1. **No overhead vs `adapter-node`** on the uncached path — identical throughput and latency, so adopting this adapter doesn't make anything slower.
2. **78× faster p50** and **61× higher throughput** on the cached path. The same backend dependency, the same SvelteKit Server, just one `platform.cache.cached(...)` call.

Run the benchmark yourself: `pnpm bench` (uses the fixture at `test/fixtures/real-sveltekit/`, takes ~30 s).

## Deployment

This adapter does **not** bundle the entry — the runtime imports `@sveltejs/kit` from `node_modules`, exactly like `@sveltejs/adapter-node`. The deploy flow on a creekd VPS:

```bash
git pull
pnpm install --prod
pnpm build
creekctl up --from .creek-creekd/manifest.json
```

The output tree (`build/` + `node_modules/`) is what creekd spawns. If your deployment strategy needs a single self-contained file (no `node_modules` on target), opt-in esbuild bundling is the P1 plan — until then this adapter is wrong for that shape.

## Comparison with `@sveltejs/adapter-node`

| | `@sveltejs/adapter-node` | `@solcreek/svelte-adapter` |
|---|---|---|
| Env-var surface (PORT, HOST, ORIGIN, PROTOCOL_HEADER, BODY_SIZE_LIMIT, …) | ✓ | ✓ identical |
| `sveltekit:shutdown` event contract | ✓ | ✓ identical |
| `node_modules` on target | required | required |
| Bun runtime support | — | ✓ first-class (`runtime: "bun"`) |
| Polka HTTP server | yes | — direct `node:http` / `Bun.serve`, no extra dep |
| Creekd process manifest (`.creek-creekd/manifest.json`) | — | ✓ `creekctl up --from` reads it |
| Configurable health probe path baked into the entry | — | ✓ (default `/_creek/health`) |
| Persistent KV on `event.platform` (`platform.cache`) | — | ✓ L1 LRU + L2 fs, tag invalidation, SWR |
| `Emulator.platform()` for dev parity | — | ✓ same cache in `vite dev` / prerender |

On the apples-to-apples path (no caching), throughput and latency are identical — adopting this adapter doesn't make anything slower. See [Benchmark](#benchmark-vs-sveltejsadapter-node) for the numbers and methodology.

## License

Apache-2.0
