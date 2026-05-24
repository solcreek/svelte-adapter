// Microbench: fs vs bun-sqlite L2 driver throughput.
// Usage: bun scripts/bench-cache-driver.mjs

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache } from "../dist/cache-handler.js";

const N = Number(process.env.N) || 1000;

async function bench(driver) {
  const dir = await mkdtemp(join(tmpdir(), `svelte-cache-bench-${driver}-`));
  const cache = createCache({ dir, driver, l1Entries: 0 });

  // Warm: force driver init (lazy).
  await cache.set("__warm", { x: 1 });

  const setStart = performance.now();
  for (let i = 0; i < N; i++) {
    await cache.set(`k${i}`, { i, payload: "x".repeat(64) });
  }
  const setMs = performance.now() - setStart;

  // Reset L1 to force L2 reads.
  await cache.close();
  const reader = createCache({ dir, driver, l1Entries: 0 });

  const getStart = performance.now();
  for (let i = 0; i < N; i++) {
    await reader.get(`k${i}`);
  }
  const getMs = performance.now() - getStart;

  await reader.close();
  await rm(dir, { recursive: true, force: true });

  return { driver, setMs, getMs, setRps: (N / setMs) * 1000, getRps: (N / getMs) * 1000 };
}

const results = [];
for (const driver of ["fs", "bun-sqlite"]) {
  results.push(await bench(driver));
}

console.log(`\nL2 driver microbench (N=${N})\n`);
console.log("driver".padEnd(12), "set ms".padStart(10), "get ms".padStart(10),
            "set/s".padStart(10), "get/s".padStart(10));
for (const r of results) {
  console.log(
    r.driver.padEnd(12),
    r.setMs.toFixed(1).padStart(10),
    r.getMs.toFixed(1).padStart(10),
    r.setRps.toFixed(0).padStart(10),
    r.getRps.toFixed(0).padStart(10),
  );
}
