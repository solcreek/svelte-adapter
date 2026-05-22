import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createCache, __test__ } from "./cache-handler.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "svelte-cache-"));
}

describe("safeTagFilename", () => {
  it("preserves identifier-safe tags", () => {
    expect(__test__.safeTagFilename("user_123")).toBe("t-user_123");
    expect(__test__.safeTagFilename("a-b-c")).toBe("t-a-b-c");
  });

  it("hashes tags with unsafe chars", () => {
    expect(__test__.safeTagFilename("user/123")).toMatch(/^h-[0-9a-f]{32}$/);
    expect(__test__.safeTagFilename("a:b")).toMatch(/^h-[0-9a-f]{32}$/);
  });

  it("hashes tags longer than 64 chars", () => {
    expect(__test__.safeTagFilename("x".repeat(65))).toMatch(/^h-[0-9a-f]{32}$/);
  });
});

describe("CreekdSvelteCache (L2 + L1)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("set then get returns the entry", async () => {
    const c = createCache({ dir });
    await c.set("k1", { a: 1 });
    const hit = await c.get<{ a: number }>("k1");
    expect(hit?.value).toEqual({ a: 1 });
    expect(hit?.tags).toEqual([]);
  });

  it("get returns null for missing keys", async () => {
    const c = createCache({ dir });
    expect(await c.get("nope")).toBeNull();
  });

  it("survives an L1 wipe by re-reading from L2", async () => {
    const c1 = createCache({ dir });
    await c1.set("k", "v1");
    // A fresh instance simulates process restart — no L1, must hit L2.
    const c2 = createCache({ dir });
    const hit = await c2.get<string>("k");
    expect(hit?.value).toBe("v1");
  });

  it("delete removes the entry from both layers", async () => {
    const c = createCache({ dir });
    await c.set("k", "v");
    await c.delete("k");
    expect(await c.get("k")).toBeNull();
    const c2 = createCache({ dir });
    expect(await c2.get("k")).toBeNull();
  });

  it("respects revalidate (seconds)", async () => {
    const c = createCache({ dir });
    await c.set("k", "v", { revalidate: 0 });
    // revalidate=0 ⇒ revalidateAfter = now; ensure clock moves past.
    await new Promise((r) => setTimeout(r, 5));
    expect(await c.get("k")).toBeNull();
  });

  it("invalidateTag makes tagged entries stale", async () => {
    const c = createCache({ dir });
    await c.set("k1", "v1", { tags: ["user:1"] });
    await c.set("k2", "v2", { tags: ["user:2"] });
    expect((await c.get("k1"))?.value).toBe("v1");

    // Move the clock forward by at least 1ms so the invalidation
    // timestamp is strictly later than createdAt.
    await new Promise((r) => setTimeout(r, 5));
    await c.invalidateTag("user:1");
    expect(await c.get("k1")).toBeNull();
    expect((await c.get("k2"))?.value).toBe("v2");
  });

  it("L1 eviction kicks in past capacity", async () => {
    const c = createCache({ dir, l1Entries: 3 });
    await c.set("a", 1);
    await c.set("b", 2);
    await c.set("c", 3);
    await c.set("d", 4); // evicts "a" from L1
    // Re-fetching "a" should still work via L2; L1 just promoted again.
    const hit = await c.get<number>("a");
    expect(hit?.value).toBe(1);
  });

  it("inMemoryOnly mode skips L2 entirely", async () => {
    const c = createCache({ dir, inMemoryOnly: true });
    await c.set("k", "v");
    // L2 should be untouched
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
    // L1 hit still works
    expect((await c.get<string>("k"))?.value).toBe("v");
    // Fresh instance can't see it
    expect(await createCache({ dir, inMemoryOnly: true }).get("k")).toBeNull();
  });
});

describe("cached() SWR helper", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("runs loader on miss and caches the result", async () => {
    const c = createCache({ dir });
    let calls = 0;
    const loader = async () => {
      calls++;
      return "loaded";
    };
    expect(await c.cached("k", {}, loader)).toBe("loaded");
    expect(await c.cached("k", {}, loader)).toBe("loaded");
    expect(calls).toBe(1);
  });

  it("coalesces concurrent misses into one loader call", async () => {
    const c = createCache({ dir });
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "loaded";
    };
    const results = await Promise.all([
      c.cached("k", {}, loader),
      c.cached("k", {}, loader),
      c.cached("k", {}, loader),
    ]);
    expect(results).toEqual(["loaded", "loaded", "loaded"]);
    expect(calls).toBe(1);
  });

  it("re-runs loader after invalidateTag", async () => {
    const c = createCache({ dir });
    let v = 1;
    const loader = async () => v;
    expect(await c.cached("k", { tags: ["t"] }, loader)).toBe(1);
    v = 2;
    await new Promise((r) => setTimeout(r, 5));
    await c.invalidateTag("t");
    expect(await c.cached("k", { tags: ["t"] }, loader)).toBe(2);
  });
});

describe("close()", () => {
  it("awaits in-flight loaders so writes complete", async () => {
    const dir = await makeTempDir();
    const c = createCache({ dir });
    let resolveLoader: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => {
      resolveLoader = r;
    });
    const p = c.cached("k", {}, () => slow);
    // Resolve a tick later so close() actually waits.
    setTimeout(() => resolveLoader("done"), 10);
    await p;
    await c.close();
    // Fresh instance should see the persisted value.
    const c2 = createCache({ dir });
    expect((await c2.get<string>("k"))?.value).toBe("done");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
