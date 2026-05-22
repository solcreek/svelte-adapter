import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isCreekdDeployManifest } from "@solcreek/adapter-core";

import { normalizeEnv, writeManifest } from "./manifest.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "svelte-adapter-"));
}

describe("normalizeEnv", () => {
  it("always defaults NODE_ENV=production", () => {
    const out = normalizeEnv(undefined);
    expect(out).toEqual(["NODE_ENV=production"]);
  });

  it("user-supplied NODE_ENV overrides the default", () => {
    expect(normalizeEnv(["NODE_ENV=staging"])).toEqual(["NODE_ENV=staging"]);
    expect(normalizeEnv({ NODE_ENV: "development" })).toEqual([
      "NODE_ENV=development",
    ]);
  });

  it("accepts KEY=VALUE strings", () => {
    const out = normalizeEnv(["PORT=4000", "FOO=bar"]);
    expect(out).toContain("NODE_ENV=production");
    expect(out).toContain("PORT=4000");
    expect(out).toContain("FOO=bar");
  });

  it("accepts object form and coerces values to strings", () => {
    const out = normalizeEnv({ PORT: 4000, DEBUG: true });
    expect(out).toContain("PORT=4000");
    expect(out).toContain("DEBUG=true");
  });

  it("rejects malformed array entries", () => {
    expect(() => normalizeEnv(["BAD"])).toThrow(/KEY=VALUE/);
    expect(() => normalizeEnv(["=VALUE"])).toThrow(/KEY=VALUE/);
  });

  it("rejects empty object keys", () => {
    expect(() => normalizeEnv({ "": "x" })).toThrow(/non-empty/);
  });
});

describe("writeManifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });

  it("emits a creekd-valid manifest with svelte-specific metadata", async () => {
    await writeManifest({
      outputDir: dir,
      buildId: "build-abc",
      runtime: "bun",
      entrypoint: "build/index.js",
      port: 3000,
      env: ["NODE_ENV=production"],
      healthCheckPath: "/_creek/health",
      serveDirs: ["build/client", "build/prerendered"],
      hasPrerender: true,
    });

    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);

    expect(isCreekdDeployManifest(parsed)).toBe(true);
    expect(parsed.target).toBe("creekd");
    expect(parsed.framework).toBe("sveltekit");
    expect(parsed.runtime).toBe("bun");
    expect(parsed.entrypoint).toBe("build/index.js");
    expect(parsed.port).toBe(3000);
    expect(parsed.health_check_path).toBe("/_creek/health");
    expect(parsed.serveDirs).toEqual(["build/client", "build/prerendered"]);
    expect(parsed.hasPrerender).toBe(true);
    expect(parsed.adapter?.name).toBe("@solcreek/svelte-adapter");
    expect(parsed.adapter?.version).toEqual(expect.any(String));
  });

  it("omits env when empty array", async () => {
    await writeManifest({
      outputDir: dir,
      buildId: "x",
      runtime: "node",
      entrypoint: "build/index.js",
      port: 3000,
      env: [],
      serveDirs: [],
      hasPrerender: false,
    });
    const parsed = JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    );
    expect(parsed.env).toBeUndefined();
  });
});
