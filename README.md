# @solcreek/svelte-adapter

SvelteKit deployment adapter for [`@solcreek/creekd`](https://github.com/solcreek/creekd) self-host. Produces a runnable HTTP server entry + a `.creek-creekd/manifest.json` describing the supervised process, so `creekctl up --from .creek-creekd/manifest.json` knows exactly what to spawn.

Pairs creekd's neutral process supervisor (cgroups, namespaces, dispatch, health probes) with SvelteKit-shaped defaults: prerendered fast-path, hashed-asset immutable caching, `X-Forwarded-*` aware URL rebuilding, `sveltekit:shutdown` graceful drain.

## Status

Pre-1.0. Targets SvelteKit ≥ 2.0. P0 ships the runtime parity table below; P1 will add `platform.cache` (persistent KV via `bun:sqlite` / fs) for SvelteKit-side caching, dev `emulate()`, and opt-in esbuild bundling.

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

Drop-in for almost everything `adapter-node` does:

- Identical env-var surface (PORT/HOST/ORIGIN/PROTOCOL_HEADER/…)
- Same `sveltekit:shutdown` event contract
- Same body-size enforcement
- Same `node_modules`-on-target deployment assumption

The differences:

- Emits a creekd `manifest.json` so `creekctl` can supervise the process (cgroup limits, dispatch, restart policy) — `adapter-node` ends at "produce build/index.js".
- Bun runtime is a first-class option, not a footnote.
- No Polka — direct `node:http` (and `Bun.serve` on Bun); fewer moving parts, no extra deps.
- Health probe is built into the entry at a configurable path so creekd doesn't need to know about it.
- Will gain `platform.cache` (persistent KV in `event.platform`) in P1, which `adapter-node` does not provide.

## License

Apache-2.0
