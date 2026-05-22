#!/usr/bin/env node
// Head-to-head HTTP benchmark: @solcreek/svelte-adapter vs @sveltejs/adapter-node
// on the same SvelteKit fixture.
//
// Scenarios:
//   /bench/slow    — 50ms simulated backend work, no caching. Apples-to-apples.
//   /bench/cached  — same work wrapped in platform.cache.cached. Only meaningful
//                    on our adapter (adapter-node returns 500).
//
// Methodology:
//   - Same fixture, same Node version, same hardware. Adapter selection via
//     BENCH_ADAPTER env var read in svelte.config.js.
//   - Each scenario: a warmup pass, then N requests at concurrency C.
//   - Latency reported as p50 / p95 / p99 over the timed pass.
//   - Throughput = N / wall-clock-time for the timed pass.
//
// Output is a plain Markdown table so it can be pasted into README.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "..", "test", "fixtures", "real-sveltekit");

const REQUESTS = Number(process.env.BENCH_REQUESTS) || 2000;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY) || 10;
const WARMUP = Number(process.env.BENCH_WARMUP) || 20;

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  throw new Error(`not ready at ${url}: ${lastErr}`);
}

function pctile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runScenario(base, urlPath) {
  // warmup
  for (let i = 0; i < WARMUP; i++) await fetch(`${base}${urlPath}`);

  const latencies = [];
  let inflight = 0;
  let started = 0;
  let completed = 0;
  let nonOk = 0;
  const start = performance.now();

  await new Promise((resolve) => {
    function pump() {
      while (inflight < CONCURRENCY && started < REQUESTS) {
        started++;
        inflight++;
        const t0 = performance.now();
        fetch(`${base}${urlPath}`)
          .then(async (res) => {
            await res.text(); // drain
            if (!res.ok) nonOk++;
            latencies.push(performance.now() - t0);
          })
          .catch(() => {
            nonOk++;
            latencies.push(performance.now() - t0);
          })
          .finally(() => {
            inflight--;
            completed++;
            if (completed === REQUESTS) resolve();
            else pump();
          });
      }
    }
    pump();
  });

  const elapsed = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    rps: REQUESTS / elapsed,
    p50: pctile(latencies, 50),
    p95: pctile(latencies, 95),
    p99: pctile(latencies, 99),
    nonOk,
    elapsed,
  };
}

async function buildFixture(env) {
  console.log(`\n→ Building fixture (BENCH_ADAPTER=${env.BENCH_ADAPTER ?? "<creek>"})`);
  await new Promise((resolve, reject) => {
    const c = spawn("pnpm", ["build"], {
      cwd: FIXTURE_DIR,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    c.once("error", reject);
    c.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
  });
}

async function spawnAndProbe(port, env) {
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: FIXTURE_DIR,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (b) => process.stderr.write(`  [child] ${b}`));

  const base = `http://127.0.0.1:${port}`;
  // Both adapters expose health at different paths; just probe /.
  await waitReady(`${base}/`);
  return { child, base };
}

async function teardown(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function fmt(n, digits = 2) {
  return Number(n).toFixed(digits);
}

async function main() {
  console.log("=".repeat(60));
  console.log(`Benchmark: ${REQUESTS} requests at concurrency ${CONCURRENCY}`);
  console.log("=".repeat(60));

  const results = {};

  // --- Our adapter ---
  await buildFixture({});
  let port = await pickPort();
  let h = await spawnAndProbe(port, {});
  console.log(`\n→ @solcreek/svelte-adapter listening at ${h.base}`);
  try {
    console.log("  running /bench/slow …");
    results.creek_slow = await runScenario(h.base, "/bench/slow");
    console.log("  running /bench/cached …");
    results.creek_cached = await runScenario(h.base, "/bench/cached");
  } finally {
    await teardown(h.child);
  }

  // --- adapter-node ---
  await buildFixture({ BENCH_ADAPTER: "node" });
  port = await pickPort();
  h = await spawnAndProbe(port, {});
  console.log(`\n→ @sveltejs/adapter-node listening at ${h.base}`);
  try {
    console.log("  running /bench/slow …");
    results.node_slow = await runScenario(h.base, "/bench/slow");
  } finally {
    await teardown(h.child);
  }

  // --- Report ---
  console.log("\n" + "=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60) + "\n");
  console.log("| Adapter | Endpoint | req/s | p50 (ms) | p95 (ms) | p99 (ms) | errors |");
  console.log("|---|---|---:|---:|---:|---:|---:|");

  const row = (label, endpoint, r) =>
    `| ${label} | \`${endpoint}\` | ${fmt(r.rps)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.nonOk} |`;

  console.log(row("@sveltejs/adapter-node", "/bench/slow", results.node_slow));
  console.log(row("@solcreek/svelte-adapter", "/bench/slow", results.creek_slow));
  console.log(row("@solcreek/svelte-adapter", "/bench/cached", results.creek_cached));

  // Headline
  const cachedSpeedup = results.node_slow.p50 / Math.max(results.creek_cached.p50, 0.01);
  console.log(
    `\nHeadline: cached p50 is ~${fmt(cachedSpeedup, 1)}× faster than the adapter-node baseline ` +
      `(${fmt(results.node_slow.p50)} ms → ${fmt(results.creek_cached.p50)} ms).`,
  );

  // Persist results so the README workflow can pick them up.
  await fs.writeFile(
    path.join(__dirname, "..", ".bench-results.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        requests: REQUESTS,
        concurrency: CONCURRENCY,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nResults persisted to .bench-results.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
