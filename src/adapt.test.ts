import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { adapt } from "./adapt.js";

type Builder = import("@sveltejs/kit").Builder;

interface MockOptions {
  prerenderedPaths?: string[];
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
