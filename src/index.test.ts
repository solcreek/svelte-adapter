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

  it("accepts bundle:false (default) and rejects any other value in P0", () => {
    expect(() => adapter({ bundle: false })).not.toThrow();
    // bundle:"esbuild" is the planned P1 value; reject it until shipped.
    expect(() => adapter({ bundle: "esbuild" as unknown as false })).toThrow(/bundle/);
  });
});
