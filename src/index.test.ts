import { describe, expect, it } from "vitest";

import adapter from "./index.js";

describe("adapter factory", () => {
  it("returns an Adapter with the package name and adapt()", () => {
    const a = adapter();
    expect(a.name).toBe("@solcreek/svelte-adapter");
    expect(typeof a.adapt).toBe("function");
  });

  it("advertises supports.read=true so $app/server read() is permitted", () => {
    const a = adapter();
    expect(a.supports?.read?.({ config: {}, route: { id: "" } })).toBe(true);
  });

  it("rejects ports outside 1..65535", () => {
    expect(() => adapter({ port: 0 })).toThrow(/port/);
    expect(() => adapter({ port: -1 })).toThrow(/port/);
    expect(() => adapter({ port: 65_536 })).toThrow(/port/);
    expect(() => adapter({ port: 3.14 })).toThrow(/port/);
  });

  it("accepts ports inside the valid range", () => {
    expect(() => adapter({ port: 1 })).not.toThrow();
    expect(() => adapter({ port: 65_535 })).not.toThrow();
  });

  it("requires healthCheckPath to start with '/'", () => {
    expect(() => adapter({ healthCheckPath: "health" })).toThrow(/health/);
    expect(() => adapter({ healthCheckPath: "/healthz" })).not.toThrow();
  });

  it("propagates malformed env from normalizeEnv at construction time", () => {
    expect(() => adapter({ env: ["BAD"] })).toThrow(/KEY=VALUE/);
  });

  it("accepts bundle:false (default) and bundle:'esbuild'; rejects anything else", () => {
    expect(() => adapter({ bundle: false })).not.toThrow();
    expect(() => adapter({ bundle: "esbuild" })).not.toThrow();
    expect(() => adapter({ bundle: true as unknown as false })).toThrow(/bundle/);
    expect(() => adapter({ bundle: "rollup" as unknown as false })).toThrow(/bundle/);
  });

  it("accepts bare .html filenames for fallback and rejects paths", () => {
    expect(() => adapter({ fallback: "200.html" })).not.toThrow();
    expect(() => adapter({ fallback: "404.html" })).not.toThrow();
    expect(() => adapter({ fallback: "index.html" })).not.toThrow();
    expect(() => adapter({ fallback: "shell.txt" })).toThrow(/fallback/);
    expect(() => adapter({ fallback: "sub/200.html" })).toThrow(/fallback/);
    expect(() => adapter({ fallback: "..\\evil.html" })).toThrow(/fallback/);
  });

  it("provides emulate().platform() with a cache instance", async () => {
    const a = adapter();
    expect(typeof a.emulate).toBe("function");
    const emulator = await a.emulate!();
    expect(typeof emulator.platform).toBe("function");
    const platform = await emulator.platform!({
      config: {} as never,
      prerender: false as never,
    });
    expect(platform).toBeDefined();
    const cache = (platform as { cache?: unknown }).cache as {
      set: (k: string, v: unknown) => Promise<void>;
      get: (k: string) => Promise<{ value: unknown } | null>;
    } | undefined;
    expect(cache).toBeDefined();
    await cache!.set("emulate-test", "ok");
    const hit = await cache!.get("emulate-test");
    expect(hit?.value).toBe("ok");
  });
});
