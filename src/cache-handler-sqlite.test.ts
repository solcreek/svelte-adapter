// bun:sqlite driver contract tests.
// Gated on Bun availability — Node `vitest run` skips this file entirely.
// Run under Bun via `bun test src/cache-handler-sqlite.test.ts` once the
// project picks up `bun test` (see test:bun script). On Node we exercise
// the auto-fallback path via the smoke test at the bottom of this file
// to prove "auto" gracefully degrades when bun:sqlite is unavailable.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createCache, resolveL2Driver } from "./cache-handler.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "svelte-cache-sqlite-"));
}

const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

describe.skipIf(!hasBun)("BunSqliteL2Driver (contract parity with fs)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("set/get round-trips a value via sqlite", async () => {
    const c = createCache({ dir, driver: "bun-sqlite" });
    await c.set("k1", { a: 1 }, { tags: ["t1"], revalidate: 60 });
    const hit = await c.get<{ a: number }>("k1");
    expect(hit?.value).toEqual({ a: 1 });
    expect(hit?.tags).toEqual(["t1"]);
    await c.close();
  });

  it("survives an L1 wipe by re-reading from the sqlite L2", async () => {
    const c1 = createCache({ dir, driver: "bun-sqlite" });
    await c1.set("k", "v1");
    await c1.close();
    // A fresh instance simulates process restart — no L1, must hit L2.
    const c2 = createCache({ dir, driver: "bun-sqlite" });
    const hit = await c2.get<string>("k");
    expect(hit?.value).toBe("v1");
    await c2.close();
  });

  it("invalidateTag marks tagged entries stale across restart", async () => {
    const c1 = createCache({ dir, driver: "bun-sqlite" });
    await c1.set("k", "v1", { tags: ["user:42"] });
    await c1.invalidateTag("user:42");
    await c1.close();

    const c2 = createCache({ dir, driver: "bun-sqlite" });
    expect(await c2.get("k")).toBeNull();
    await c2.close();
  });

  it("delete removes the entry from the sqlite row set", async () => {
    const c = createCache({ dir, driver: "bun-sqlite" });
    await c.set("k", "v");
    await c.delete("k");
    expect(await c.get("k")).toBeNull();
    await c.close();
  });

  it("writes the cache.sqlite file under dir", async () => {
    const c = createCache({ dir, driver: "bun-sqlite" });
    await c.set("k", "v");
    await c.close();
    const stat = await fs.stat(path.join(dir, "cache.sqlite"));
    expect(stat.isFile()).toBe(true);
  });
});

describe("resolveL2Driver", () => {
  it("returns an FsL2Driver when driver=fs", async () => {
    const dir = await makeTempDir();
    const driver = await resolveL2Driver("fs", dir);
    expect(driver.constructor.name).toBe("FsL2Driver");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(hasBun)("falls back to FsL2Driver when driver=auto on Node", async () => {
    const dir = await makeTempDir();
    const driver = await resolveL2Driver("auto", dir);
    expect(driver.constructor.name).toBe("FsL2Driver");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(hasBun)("throws when driver=bun-sqlite requested on Node", async () => {
    const dir = await makeTempDir();
    await expect(resolveL2Driver("bun-sqlite", dir)).rejects.toThrow(/bun:sqlite/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
