# Changelog

All notable changes to `@solcreek/svelte-adapter` are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `pnpm bench` — head-to-head HTTP benchmark vs `@sveltejs/adapter-node`
  on the same SvelteKit fixture. `/bench/slow` (50 ms simulated work)
  matches `adapter-node` exactly (191 req/s, 52 ms p50); `/bench/cached`
  via `platform.cache.cached` reaches **11,680 req/s at 0.67 ms p50**
  (~78× faster p50, ~61× higher throughput).
- `@sveltejs/adapter-node` as a devDependency of the bench fixture, plus
  a `BENCH_ADAPTER=node` switch in `svelte.config.js` so one fixture
  builds either way.
- README "Benchmark vs `@sveltejs/adapter-node`" section.
- `scripts/test-creekctl-integration.sh` — end-to-end test against
  real `creekd` + `creekctl` binaries from the sibling repo. Validates
  that the `.creek-creekd/manifest.json` we emit is consumable by
  `creekctl up --from`, that creekd routes traffic through the
  dispatch listener (`X-Creek-App` header) to our entry, and that
  every surface (SSR, prerender, +server.ts, `$app/server` `read()`,
  `platform.cache`) still works through the full chain.

## [0.2.0] - 2026-05-22

### Added

- `event.platform.cache` — persistent KV exposed to SvelteKit user code.
  L1 is an in-process LRU (default 2048 entries); L2 is filesystem JSON at
  `$CREEK_SVELTE_CACHE_DIR/entries/<hash[0:2]>/<hash>.json` written atomically
  via tmp+rename. Survives process restart.
- Tag invalidation via `platform.cache.invalidateTag(tag)` — uses per-tag
  sentinel files compared against entry `createdAt`, no global tag→keys
  index to keep coherent.
- `platform.cache.cached(key, opts, loader)` — stale-while-revalidate helper
  that coalesces concurrent misses for the same key so cold-start herds
  don't multiply loader calls.
- `Emulator.platform()` — injects the same cache during `vite dev` and
  prerender so user code can use `event.platform.cache` uniformly across
  dev / build / prod without `if (import.meta.env.DEV)` branches.
- `CREEK_SVELTE_CACHE_DIR`, `CREEK_SVELTE_CACHE_L1`,
  `CREEK_SVELTE_CACHE_DISABLED` runtime env vars to control cache location,
  L1 capacity, and disable L2.
- `@solcreek/svelte-adapter/runtime` subpath export for direct consumption
  of `createCache` and types (`CreekdSvelteCache`, `CacheEntry`,
  `SetOptions`, `CreekdSvelteCacheOptions`).
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs typecheck,
  build, and test (including `RUN_REAL_E2E=1`) on every push to `main`
  and on pull requests.
- README section documenting `platform.cache` usage, env vars, and how
  to declare `App.Platform` for autocomplete.

### Changed

- Build output is now self-contained: `adapt()` copies `runtime.js` and
  `cache-handler.js` next to the generated entry, so production deploys
  do **not** need `@solcreek/svelte-adapter` in target `node_modules` —
  only `@sveltejs/kit`.
- `sveltekit:shutdown` drain now also awaits `cache.close()` so
  in-flight L2 writes finish before the socket closes.
- Publish workflow bumped off Node 20 actions (`actions/checkout@v4` →
  `@v5`, `actions/setup-node@v4` → `@v5`, `pnpm/action-setup@v4` →
  `@v6`) ahead of the 2026-06-02 forced Node 24 cutover.
- Publish workflow added `workflow_dispatch` trigger for manual dry-run
  verification — `npm publish` is gated on `github.event_name == 'push'`
  so manual runs never cut a release.

### Security

- This is the first release published via npm OIDC Trusted Publishing
  with SLSA provenance v1 attestations attached. Verify with
  `npm audit signatures` once consuming.

## [0.1.0] - 2026-05-22

Initial release. Establishes adapter parity with `@sveltejs/adapter-node`
for SvelteKit deployments targeting [`@solcreek/creekd`](https://github.com/solcreek/creekd)
self-host, with Bun as a first-class runtime alongside Node.

### Added

- SvelteKit `Adapter` implementation that emits:
  - A runtime entry at `build/index.js` for Node or Bun.
  - The standard SvelteKit `client/`, `server/`, `prerendered/` trees.
  - A `manifest.js` wrapping `builder.generateManifest({ relativePath })`.
  - A creekd process descriptor at `.creek-creekd/manifest.json` typed as
    `CreekdDeployManifest` from `@solcreek/adapter-core`, consumable via
    `creekctl up --from`.
- `runtime: "bun" | "node"` option (default `"bun"`). Selecting Bun causes
  the manifest to record `bun` and emits a `Bun.serve`-based entry; Node
  emits a `node:http` + `@sveltejs/kit/node` `getRequest` / `setResponse`
  entry.
- `@sveltejs/kit/node/polyfills` imported at the top of the Node entry so
  `File` / `FormData` / multipart streaming behave the same as
  `adapter-node`.
- `ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`, `PORT_HEADER` runtime env
  vars for proxy-aware URL reconstruction — creekd dispatch sits in front
  of the supervised process, so `event.url` would otherwise always be
  the loopback address.
- `ADDRESS_HEADER` + `XFF_DEPTH` for proxy-aware `getClientAddress()`.
  Opt-in (no auto X-Forwarded-For trust) — matches `adapter-node`'s
  security model.
- `BODY_SIZE_LIMIT` (default 512 KB) — requests above the cap are
  rejected with `413 Payload Too Large`.
- `SHUTDOWN_TIMEOUT` (default 30s) graceful drain on `SIGINT` / `SIGTERM`,
  emitting the `sveltekit:shutdown` event with the signal as the reason
  and awaiting async listeners before closing the socket.
- Static fast-path for `client/` and `prerendered/` ahead of
  `Server.respond`, with `cache-control: public, max-age=31536000,
  immutable` on `_app/immutable/*`. Prerendered routes resolve three
  forms: exact path, path + `.html`, and directory + `index.html`.
- Built-in health probe at a configurable path (default
  `/_creek/health`); the same path is written into the creekd manifest
  so the supervisor probes what the entry serves.
- `supports.read = () => true` plus `read: (file) => readFileSync(...)`
  in `server.init` so `$app/server` `read()` works.
- `precompress` option (default `true`) — runs `builder.compress` over
  client + prerendered output (gzip + brotli).
- `env` option — additive over the implicit `NODE_ENV=production`
  default; accepts `KEY=VALUE` strings or an object.
- `healthCheckPath` option (default `/_creek/health`) recorded both into
  the entry and the creekd manifest.
- `out` option (default `"build"`) for the output directory.
- `bundle` option reserved on the API surface — currently only accepts
  `false`, will land esbuild bundling in a later release without a
  breaking change.
- npm OIDC Trusted Publishing workflow (`.github/workflows/publish.yml`)
  triggered on `v*` tag push.
- Synthetic-tree e2e test suite covering the HTTP surface (Node + Bun):
  static, prerendered, SSR fallback, body forwarding, status codes,
  streaming, X-Forwarded-* rewriting, ADDRESS_HEADER + XFF_DEPTH,
  BODY_SIZE_LIMIT, sveltekit:shutdown event, path traversal.
- Real-SvelteKit fixture e2e (gated behind `RUN_REAL_E2E=1`) — `vite
  build`s a minimal app against the adapter and exercises SSR,
  prerendered routes, `+server.ts` GET/POST, `$app/server read()`, and
  immutable cache headers on hashed assets.

[Unreleased]: https://github.com/solcreek/svelte-adapter/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/solcreek/svelte-adapter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/solcreek/svelte-adapter/releases/tag/v0.1.0
