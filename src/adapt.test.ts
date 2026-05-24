import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { adapt } from "./adapt.js";

type Builder = import("@sveltejs/kit").Builder;

interface MockOptions {
  prerenderedPaths?: string[];
  hasInstrumentation?: boolean;
  serverAssets?: string[];
  serverAssetSourceDir?: string;
}

function createMockBuilder(opts: MockOptions = {}): Builder {
  const builder = {
    log: {
      minor: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    // The real Builder API is synchronous for these — match that so
    // adapt() doesn't need to await them. Async mocks would be silently
    // dropped because the call sites don't await.
    rimraf: vi.fn((dir: string) => {
      rmSync(dir, { recursive: true, force: true });
    }),
    mkdirp: vi.fn((dir: string) => {
      mkdirSync(dir, { recursive: true });
    }),
    writeClient: vi.fn((dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "marker-client.txt"), "client");
      return ["marker-client.txt"];
    }),
    writeServer: vi.fn((dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "index.js"), "export class Server {}\n");
      return ["index.js"];
    }),
    writePrerendered: vi.fn((dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "about.html"), "<h1>about</h1>");
      return ["about.html"];
    }),
    generateManifest: vi.fn(({ relativePath }) => {
      return `{ appPath: "_app", relativePath: ${JSON.stringify(relativePath)} }`;
    }),
    generateEnvModule: vi.fn(() => {}),
    prerendered: {
      paths: opts.prerenderedPaths ?? ["/about"],
      pages: new Map(),
      assets: new Map(),
      redirects: new Map(),
    },
    routes: [],
    compress: vi.fn(async () => {}),
    config: {} as Builder["config"],
    getBuildDirectory: vi.fn((name: string) => `.svelte-kit/${name}`),
    hasServerInstrumentationFile: vi.fn(() => opts.hasInstrumentation ?? false),
    instrument: vi.fn(() => {}),
    findServerAssets: vi.fn(() => opts.serverAssets ?? []),
    getServerDirectory: vi.fn(() => opts.serverAssetSourceDir ?? ""),
    generateFallback: vi.fn(async (dest: string) => {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, "<!doctype html><html><body>fallback shell</body></html>");
    }),
  };
  return builder as unknown as Builder;
}

describe("adapt", () => {
  let tmp: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "svelte-adapt-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("emits client, server, prerendered directories under out", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: ["NODE_ENV=production"],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });

    expect(existsSync(path.join(tmp, "build", "client", "marker-client.txt"))).toBe(true);
    expect(existsSync(path.join(tmp, "build", "server", "index.js"))).toBe(true);
    expect(existsSync(path.join(tmp, "build", "prerendered", "about.html"))).toBe(true);
  });

  it("writes manifest.js with both manifest and prerendered exports", async () => {
    const builder = createMockBuilder({ prerenderedPaths: ["/about", "/contact"] });
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });

    const manifestJs = await fs.readFile(
      path.join(tmp, "build", "manifest.js"),
      "utf8",
    );
    expect(manifestJs).toContain("export const manifest");
    expect(manifestJs).toContain("export const prerendered");
    expect(manifestJs).toContain("/about");
    expect(manifestJs).toContain("/contact");
    expect(manifestJs).toContain(`"./server"`);
  });

  it.each([
    ["node", "createServer"],
    ["bun", "Bun.serve"],
  ] as const)("generates %s entry with port and health placeholders substituted", async (runtime, marker) => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime,
      port: 4567,
      env: [],
      healthCheckPath: "/alive",
      precompress: false,
    });

    const entry = await fs.readFile(path.join(tmp, "build", "index.js"), "utf8");
    expect(entry).toContain(marker);
    expect(entry).toContain("4567");
    expect(entry).toContain('"/alive"');
    expect(entry).not.toContain("__CREEK_PORT__");
    expect(entry).not.toContain("__CREEK_HEALTH__");
  });

  it("writes .creek-creekd/manifest.json with correct entrypoint and serveDirs", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "bun",
      port: 3000,
      env: ["NODE_ENV=production", "FOO=bar"],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });

    const raw = await fs.readFile(
      path.join(tmp, ".creek-creekd", "manifest.json"),
      "utf8",
    );
    const m = JSON.parse(raw);
    expect(m.entrypoint).toBe(path.join("build", "index.js"));
    expect(m.serveDirs).toEqual([
      path.join("build", "client"),
      path.join("build", "prerendered"),
    ]);
    expect(m.runtime).toBe("bun");
    expect(m.hasPrerender).toBe(true);
    expect(m.env).toContain("FOO=bar");
  });

  it("calls compress when precompress=true", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: true,
    });
    expect(builder.compress).toHaveBeenCalledTimes(2);
  });

  it("skips compress when precompress=false", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(builder.compress).not.toHaveBeenCalled();
  });

  it("cleans the out directory before writing", async () => {
    const buildDir = path.join(tmp, "build");
    await fs.mkdir(buildDir, { recursive: true });
    await fs.writeFile(path.join(buildDir, "stale.txt"), "old");

    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });

    expect(existsSync(path.join(buildDir, "stale.txt"))).toBe(false);
  });

  it("copies runtime modules next to the entry for self-contained output", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(existsSync(path.join(tmp, "build", "runtime.js"))).toBe(true);
    expect(existsSync(path.join(tmp, "build", "cache-handler.js"))).toBe(true);
  });

  it("invokes builder.generateEnvModule so $env/dynamic/public works", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(builder.generateEnvModule).toHaveBeenCalledTimes(1);
  });

  it("copies server-imported assets reported by findServerAssets into serverDir", async () => {
    // Stage source assets in a fake "server output" dir that the
    // builder reports via getServerDirectory().
    const srcServerDir = await fs.mkdtemp(path.join(os.tmpdir(), "adapt-srv-"));
    await fs.mkdir(path.join(srcServerDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(srcServerDir, "logo.png"), "PNG-BYTES");
    await fs.writeFile(path.join(srcServerDir, "nested", "data.json"), '{"a":1}');

    const builder = createMockBuilder({
      serverAssets: ["logo.png", "nested/data.json"],
      serverAssetSourceDir: srcServerDir,
    });
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });

    expect(builder.findServerAssets).toHaveBeenCalledWith(builder.routes);
    expect(
      await fs.readFile(path.join(tmp, "build", "server", "logo.png"), "utf8"),
    ).toBe("PNG-BYTES");
    expect(
      await fs.readFile(path.join(tmp, "build", "server", "nested", "data.json"), "utf8"),
    ).toBe('{"a":1}');

    await fs.rm(srcServerDir, { recursive: true, force: true });
  });

  it("does not call findServerAssets results when none reported", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(builder.findServerAssets).toHaveBeenCalledTimes(1);
    // getServerDirectory should not be hit when there's nothing to copy.
    expect(builder.getServerDirectory).not.toHaveBeenCalled();
  });

  it("generates fallback HTML in prerenderedDir when fallback option set", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
      fallback: "200.html",
    });
    expect(builder.generateFallback).toHaveBeenCalledTimes(1);
    expect(builder.generateFallback).toHaveBeenCalledWith(
      path.join(tmp, "build", "prerendered", "200.html"),
    );
    const html = await fs.readFile(path.join(tmp, "build", "prerendered", "200.html"), "utf8");
    expect(html).toContain("fallback shell");
  });

  it("does not call generateFallback when fallback unset", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(builder.generateFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["200.html", "200"],
    ["404.html", "404"],
    ["index.html", "200"],
  ] as const)("substitutes fallback filename %s into entry as JSON string", async (fallback) => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
      fallback,
    });
    const entry = await fs.readFile(path.join(tmp, "build", "index.js"), "utf8");
    expect(entry).toContain(`"${fallback}"`);
    expect(entry).not.toContain("__CREEK_FALLBACK__");
  });

  it("entry placeholder __CREEK_FALLBACK__ becomes null when fallback unset", async () => {
    const builder = createMockBuilder();
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    const entry = await fs.readFile(path.join(tmp, "build", "index.js"), "utf8");
    expect(entry).toContain("const FALLBACK = null;");
    expect(entry).not.toContain("__CREEK_FALLBACK__");
  });

  describe("bundle: 'esbuild'", () => {
    // esbuild's bundle pass needs `@sveltejs/kit/node` resolvable from
    // the build entry. The harness tmp has no node_modules; symlink
    // the adapter's own (which has kit as a devDep) so node-resolution
    // walks UP from build/index.js → tmp/node_modules → kit. Mirrors
    // what the e2e harness does for the same reason.
    const ADAPTER_NODE_MODULES = path.resolve(__dirname, "..", "node_modules");
    beforeEach(async () => {
      await fs.symlink(ADAPTER_NODE_MODULES, path.join(tmp, "node_modules"), "dir");
    });

    it("inlines runtime imports and removes the on-disk runtime files", async () => {
      const builder = createMockBuilder();
      await adapt(builder, {
        outDir: "build",
        runtime: "node",
        port: 3000,
        env: [],
        healthCheckPath: "/_creek/health",
        precompress: false,
        bundle: "esbuild",
      });

      const entry = await fs.readFile(path.join(tmp, "build", "index.js"), "utf8");
      // The placeholder substitutions still landed BEFORE bundling.
      expect(entry).not.toContain("__CREEK_PORT__");
      // After bundling, the relative ./runtime.js import is inlined —
      // the literal string must not survive (would mean the bundler
      // left it external, which would break at runtime).
      expect(entry).not.toMatch(/from\s+["']\.\/runtime\.js["']/);
      expect(entry).not.toMatch(/from\s+["']\.\/cache-handler\.js["']/);
      // @sveltejs/kit/node helpers are inlined too — the bare specifier
      // must not appear as a top-level import in the bundled output.
      expect(entry).not.toMatch(/^import\s+.*from\s+["']@sveltejs\/kit\/node["']/m);
      // ./server/index.js MUST stay external (kit's Server dynamically
      // imports route modules relative to its own location). Its
      // dynamic import string survives in the bundle in some shape;
      // we don't assert presence — we assert the dead source files are
      // gone so the artifact reflects the new shape.
      const { existsSync: ex } = await import("node:fs");
      expect(ex(path.join(tmp, "build", "runtime.js"))).toBe(false);
      expect(ex(path.join(tmp, "build", "cache-handler.js"))).toBe(false);
      expect(ex(path.join(tmp, "build", "cache-handler-sqlite.js"))).toBe(false);
      // server/, manifest.js, prerendered/ must NOT be removed.
      expect(ex(path.join(tmp, "build", "manifest.js"))).toBe(true);
      expect(ex(path.join(tmp, "build", "server", "index.js"))).toBe(true);
    });

    it("does not touch runtime files when bundle is false (default)", async () => {
      const builder = createMockBuilder();
      await adapt(builder, {
        outDir: "build",
        runtime: "node",
        port: 3000,
        env: [],
        healthCheckPath: "/_creek/health",
        precompress: false,
      });
      const { existsSync: ex } = await import("node:fs");
      expect(ex(path.join(tmp, "build", "runtime.js"))).toBe(true);
      expect(ex(path.join(tmp, "build", "cache-handler.js"))).toBe(true);
    });

    it("includes inline sourcemap so production stack traces stay readable", async () => {
      const builder = createMockBuilder();
      await adapt(builder, {
        outDir: "build",
        runtime: "node",
        port: 3000,
        env: [],
        healthCheckPath: "/_creek/health",
        precompress: false,
        bundle: "esbuild",
      });
      const entry = await fs.readFile(path.join(tmp, "build", "index.js"), "utf8");
      expect(entry).toMatch(/sourceMappingURL=data:application\/json;base64,/);
    });

    it("produces a noticeably larger entry than the unbundled stub (bundling actually happened)", async () => {
      await adapt(createMockBuilder(), {
        outDir: "buildA",
        runtime: "node",
        port: 3000,
        env: [],
        healthCheckPath: "/_creek/health",
        precompress: false,
      });
      await adapt(createMockBuilder(), {
        outDir: "buildB",
        runtime: "node",
        port: 3000,
        env: [],
        healthCheckPath: "/_creek/health",
        precompress: false,
        bundle: "esbuild",
      });
      const unbundled = (await fs.stat(path.join(tmp, "buildA", "index.js"))).size;
      const bundled = (await fs.stat(path.join(tmp, "buildB", "index.js"))).size;
      // The bundled entry inlines @sveltejs/kit/node + polyfills +
      // cache handler. Even excluding the stub server it should be
      // an order of magnitude larger than the bare entry template.
      expect(bundled).toBeGreaterThan(unbundled * 5);
    });
  });

  it("wraps entry via builder.instrument when instrumentation.server file exists", async () => {
    const builder = createMockBuilder({ hasInstrumentation: true });
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(builder.instrument).toHaveBeenCalledTimes(1);
    expect(builder.instrument).toHaveBeenCalledWith({
      entrypoint: path.join(tmp, "build", "index.js"),
      instrumentation: path.join(tmp, "build", "server", "instrumentation.server.js"),
    });
  });

  it("does not call builder.instrument when user has no instrumentation file", async () => {
    const builder = createMockBuilder({ hasInstrumentation: false });
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    expect(builder.instrument).not.toHaveBeenCalled();
  });

  it("reports hasPrerender=false when no pages were prerendered", async () => {
    const builder = createMockBuilder({ prerenderedPaths: [] });
    await adapt(builder, {
      outDir: "build",
      runtime: "node",
      port: 3000,
      env: [],
      healthCheckPath: "/_creek/health",
      precompress: false,
    });
    const m = JSON.parse(
      await fs.readFile(path.join(tmp, ".creek-creekd", "manifest.json"), "utf8"),
    );
    expect(m.hasPrerender).toBe(false);
  });
});
