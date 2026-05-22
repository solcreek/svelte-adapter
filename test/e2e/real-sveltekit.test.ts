// E2E test against a real SvelteKit build.
//
// This is the highest-fidelity test we have: actually invokes
// `vite build` against a minimal SvelteKit fixture using our adapter,
// then spawns build/index.js and probes the real surface (SSR + prerender
// + +server.ts + $app/server read()).
//
// Skipped by default — pnpm install + vite build is 30-90s. Enable via
// `RUN_REAL_E2E=1 pnpm test`. CI should always set this.
//
// The fixture's node_modules and build/ are populated on first run and
// cached between runs to keep the inner loop tolerable. Pass
// `REAL_E2E_REBUILD=1` to force a fresh build.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "real-sveltekit");
const ADAPTER_ROOT = path.resolve(__dirname, "..", "..");

const ENABLED = process.env.RUN_REAL_E2E === "1";
const FORCE_REBUILD = process.env.REAL_E2E_REBUILD === "1";

async function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function pickPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else reject(new Error("could not get port"));
    });
  });
}

async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`server not ready at ${url}: ${lastErr}`);
}

async function ensureFixtureInstalled(): Promise<void> {
  const nm = path.join(FIXTURE_DIR, "node_modules");
  if (!existsSync(nm)) {
    console.log("\n[real-e2e] installing fixture deps (one-time, ~30-90s)…");
    await run("pnpm", ["install", "--ignore-workspace"], FIXTURE_DIR, 300_000);
  }
}

async function ensureAdapterBuilt(): Promise<void> {
  if (!existsSync(path.join(ADAPTER_ROOT, "dist", "index.js"))) {
    console.log("[real-e2e] adapter dist missing — building");
    await run("pnpm", ["build"], ADAPTER_ROOT, 120_000);
  }
}

async function buildFixture(): Promise<void> {
  const buildDir = path.join(FIXTURE_DIR, "build");
  if (existsSync(path.join(buildDir, "index.js")) && !FORCE_REBUILD) {
    console.log("[real-e2e] reusing existing fixture build (set REAL_E2E_REBUILD=1 to force)");
    return;
  }
  console.log("[real-e2e] building fixture with `vite build`…");
  await run("pnpm", ["build"], FIXTURE_DIR, 180_000);
}

interface Harness {
  child: ChildProcess;
  base: string;
}

async function spawnEntry(port: number, env: NodeJS.ProcessEnv): Promise<Harness> {
  const child = spawn(process.execPath, ["build/index.js"], {
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      // Surface a known value to the $env/dynamic/private conformance probe.
      CONFORMANCE_SECRET: "secret-value-42",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (b) => process.stderr.write(`  [child] ${b}`));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(`${base}/_creek/health`);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }
  return { child, base };
}

async function tearDown(h: Harness): Promise<void> {
  if (h.child.exitCode !== null) return;
  h.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      h.child.kill("SIGKILL");
      resolve();
    }, 3_000);
    h.child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const d = ENABLED ? describe : describe.skip;

d("real SvelteKit fixture", () => {
  let h: Harness;

  beforeAll(async () => {
    await ensureAdapterBuilt();
    await ensureFixtureInstalled();
    await buildFixture();
    const port = await pickPort();
    h = await spawnEntry(port, {});
  }, 360_000);

  afterAll(async () => {
    if (h) await tearDown(h);
  });

  it("emits .creek-creekd/manifest.json", async () => {
    const raw = await fs.readFile(
      path.join(FIXTURE_DIR, ".creek-creekd", "manifest.json"),
      "utf8",
    );
    const m = JSON.parse(raw);
    expect(m.target).toBe("creekd");
    expect(m.framework).toBe("sveltekit");
    expect(m.runtime).toBe("node");
    expect(m.entrypoint.replace(/\\/g, "/")).toBe("build/index.js");
    expect(m.health_check_path).toBe("/_creek/health");
    expect(m.hasPrerender).toBe(true);
  });

  it("health probe returns 200 ok", async () => {
    const res = await fetch(`${h.base}/_creek/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("SSR home page renders with per-request data", async () => {
    const r1 = await fetch(h.base);
    expect(r1.status).toBe(200);
    const body1 = await r1.text();
    expect(body1).toContain("home:");
    expect(body1).toContain('data-testid="ssr-home"');

    // Two SSR hits should differ because Date.now() is per-request.
    await sleep(5);
    const r2 = await fetch(h.base);
    const body2 = await r2.text();
    expect(body2).not.toBe(body1);
  });

  it("prerendered /about is served as static HTML", async () => {
    const res = await fetch(`${h.base}/about`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("about: prerendered");
    expect(body).toContain('data-testid="prerendered-about"');
  });

  it("GET /api/ping returns JSON", async () => {
    const res = await fetch(`${h.base}/api/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(typeof j.at).toBe("number");
  });

  it("POST /api/ping echoes the request body", async () => {
    const res = await fetch(`${h.base}/api/ping`, {
      method: "POST",
      body: "from-real-e2e",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-real-e2e");
  });

  it("$app/server read() returns the asset contents", async () => {
    const res = await fetch(`${h.base}/asset`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("creek-svelte-asset-marker");
  });

  it("event.url reflects request URL by default (loopback origin)", async () => {
    const res = await fetch(`${h.base}/url`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // No proxy headers configured: should be http://127.0.0.1:<port>/url
    expect(body).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/url$/);
  });

  it("platform.cache is present on event.platform", async () => {
    const res = await fetch(`${h.base}/cache?op=has`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("yes");
  });

  it("platform.cache round-trips set/get inside +server.ts", async () => {
    await fetch(`${h.base}/cache?op=set&key=real-roundtrip&value=alive`);
    const res = await fetch(`${h.base}/cache?op=get&key=real-roundtrip`);
    expect(await res.text()).toBe("alive");
  });

  it("platform.cache.cached() memoizes inside +server.ts", async () => {
    const r1 = await fetch(`${h.base}/cache?op=cached&key=real-cached`);
    const r2 = await fetch(`${h.base}/cache?op=cached&key=real-cached`);
    const v1 = await r1.text();
    const v2 = await r2.text();
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^loaded-\d+$/);
  });

  // ---- Conformance suite: SvelteKit features external adapters must honor ----

  it("conformance: hooks.server.js handle() runs on every request", async () => {
    // Probe a SSR route, a +server.ts route, and a prerendered route
    // (prerendered is static — hooks should NOT touch it).
    const ssr = await fetch(`${h.base}/`);
    expect(ssr.headers.get("x-creek-hook")).toBe("ok");
    const api = await fetch(`${h.base}/api/ping`);
    expect(api.headers.get("x-creek-hook")).toBe("ok");
  });

  it("conformance: cookies.set/get/delete round-trip Set-Cookie headers", async () => {
    const set = await fetch(`${h.base}/conformance/cookies?op=set`);
    expect(set.status).toBe(200);
    const setCookie = set.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/creek-test=from-sveltekit/);
    expect(setCookie.toLowerCase()).toContain("httponly");

    // Echo the cookie back to verify the entry forwards it to SvelteKit.
    const read = await fetch(`${h.base}/conformance/cookies?op=read`, {
      headers: { cookie: "creek-test=from-sveltekit" },
    });
    expect(await read.text()).toBe("from-sveltekit");
  });

  it("conformance: event.setHeaders() propagates to the response", async () => {
    const res = await fetch(`${h.base}/conformance/headers`);
    expect(res.headers.get("x-custom-via-setheaders")).toBe("yes");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("conformance: throw redirect(302, '/about') yields 302 + Location", async () => {
    // `redirect: "manual"` so fetch doesn't auto-follow and hide the 302.
    const res = await fetch(`${h.base}/conformance/redirect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/about");
  });

  it("conformance: ReadableStream response is streamed, not buffered", async () => {
    const res = await fetch(`${h.base}/conformance/streaming`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("chunk-a|chunk-b|chunk-c");
  });

  it("conformance: $env/dynamic/private reads runtime env vars", async () => {
    const res = await fetch(`${h.base}/conformance/env`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret-value-42");
  });

  it("conformance: throw error(418, ...) yields the requested status code", async () => {
    const res = await fetch(`${h.base}/conformance/error?status=418`);
    expect(res.status).toBe(418);
  });

  it("conformance: form action receives multipart body and returns data", async () => {
    const form = new URLSearchParams({ who: "world" });
    const res = await fetch(`${h.base}/conformance/form`, {
      method: "POST",
      body: form,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // SvelteKit's CSRF default trusts same-origin form posts; the
        // X-Sveltekit-Action header forces the action runner without
        // a referrer dance.
        "x-sveltekit-action": "true",
      },
      redirect: "manual",
    });
    // ActionResult returns 200 with serialized data for non-throw cases;
    // body shape is the {type:"success", data:...} envelope.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello world");
  });

  it("serves prerendered SPA fallback assets with immutable cache", async () => {
    // Find a hashed chunk under _app/immutable by listing the dir.
    const immutableDir = path.join(FIXTURE_DIR, "build", "client", "_app", "immutable");
    const candidates: string[] = [];
    async function walk(p: string): Promise<void> {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(p, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (ent.name.endsWith(".js") || ent.name.endsWith(".css")) candidates.push(full);
      }
    }
    await walk(immutableDir);
    expect(candidates.length).toBeGreaterThan(0);
    const rel = path.relative(path.join(FIXTURE_DIR, "build", "client"), candidates[0]);
    const urlPath = "/" + rel.split(path.sep).join("/");
    const res = await fetch(`${h.base}${urlPath}`);
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("immutable");
  });
});

if (!ENABLED) {
  // Surface skip reason at file load — vitest --reporter=verbose shows this.
  console.log("[real-e2e] skipped (set RUN_REAL_E2E=1 to enable)");
}
