// E2E test for the runtime entry templates (node.js / bun.js).
//
// Strategy: stand up a synthetic build tree that mimics what adapt()
// produces, but replace the real SvelteKit Server with a stub. Then
// substitute placeholders into our entry template, write it next to
// the stub server, spawn it, and exercise the HTTP surface.
//
// Why synthetic and not a real `svelte-kit build`: SvelteKit pulls in
// Vite + Svelte (~100 MB install) and adds 5-15s build time per test
// run. The entry templates have very little SvelteKit-specific code —
// the failure modes are in static serve, body bridging, header copy,
// graceful shutdown. Those are all testable here.
//
// A real-SvelteKit fixture is a separate test target (test/e2e/svelte-kit/)
// gated behind an env var so CI can run it but the inner loop stays fast.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ADAPTER_ROOT = path.resolve(__dirname, "..", "..");
const ENTRY_SRC_DIR = path.join(ADAPTER_ROOT, "src", "entries");
const ADAPTER_DIST_DIR = path.join(ADAPTER_ROOT, "dist");
const ADAPTER_NODE_MODULES = path.join(ADAPTER_ROOT, "node_modules");
const RUNTIME_FILES = ["runtime.js", "cache-handler.js", "cache-handler-sqlite.js"];

// A stub of SvelteKit's Server: just enough surface area for the entry
// to call new Server(manifest) / server.init() / server.respond().
const STUB_SERVER = `
export class Server {
  constructor(manifest) {
    this.manifest = manifest;
  }
  async init({ env, read }) {
    this.env = env;
    this.read = read;
  }
  async respond(request, info) {
    const url = new URL(request.url);
    if (url.pathname === "/echo-method") {
      return new Response(request.method, { headers: { "x-handled-by": "stub" } });
    }
    if (url.pathname === "/echo-body" && request.method === "POST") {
      const body = await request.text();
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/echo-header") {
      return new Response(request.headers.get("x-test") ?? "", {
        headers: { "x-client-address": info.getClientAddress() }
      });
    }
    if (url.pathname === "/echo-url") {
      // Reflects the URL SvelteKit sees AFTER adapter rewrites it from
      // X-Forwarded-* headers.
      return new Response(request.url);
    }
    if (url.pathname === "/install-shutdown-listener") {
      const file = url.searchParams.get("file");
      process.on("sveltekit:shutdown", async (reason) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(file, "shutdown:" + reason);
      });
      return new Response("listener-installed");
    }
    // ---- Cache exercises ----
    if (url.pathname === "/cache/has") {
      // platform.cache must be present on the platform object so user
      // code can use it directly without runtime checks.
      const present = info.platform && typeof info.platform.cache?.set === "function";
      return new Response(present ? "yes" : "no");
    }
    if (url.pathname === "/cache/set") {
      const key = url.searchParams.get("key") ?? "k";
      const value = url.searchParams.get("value") ?? "v";
      await info.platform.cache.set(key, value);
      return new Response("set");
    }
    if (url.pathname === "/cache/get") {
      const key = url.searchParams.get("key") ?? "k";
      const hit = await info.platform.cache.get(key);
      return new Response(hit ? String(hit.value) : "MISS");
    }
    if (url.pathname === "/cache/cached") {
      // Exercise the SWR coalescing path.
      const key = url.searchParams.get("key") ?? "k";
      const value = await info.platform.cache.cached(key, {}, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "loaded-" + Date.now();
      });
      return new Response(value);
    }
    if (url.pathname === "/cache/invalidate-tag") {
      const tag = url.searchParams.get("tag") ?? "t";
      await info.platform.cache.invalidateTag(tag);
      return new Response("invalidated");
    }
    if (url.pathname === "/cache/set-tagged") {
      const key = url.searchParams.get("key") ?? "k";
      const value = url.searchParams.get("value") ?? "v";
      const tag = url.searchParams.get("tag") ?? "t";
      await info.platform.cache.set(key, value, { tags: [tag] });
      return new Response("set-tagged");
    }
    if (url.pathname === "/stream") {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-1|"));
          await new Promise(r => setTimeout(r, 10));
          controller.enqueue(new TextEncoder().encode("chunk-2"));
          controller.close();
        }
      });
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/status-418") {
      return new Response("teapot", { status: 418 });
    }
    if (url.pathname === "/will-404") {
      return new Response("nf", { status: 404 });
    }
    return new Response("ssr-default", { headers: { "x-handled-by": "stub" } });
  }
}
`;

const STUB_MANIFEST_JS = `
export const manifest = { appPath: "_app" };
export const prerendered = new Set(["/about"]);
`;

async function buildSyntheticTree(
  runtime: "node" | "bun",
  port: number,
  healthPath: string,
  fallback: string | null = null,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `svelte-entry-${runtime}-`));
  // The entry imports `@sveltejs/kit/node` and the polyfill — resolved
  // from node_modules. Symlink the adapter's own node_modules into the
  // synthetic tree so module resolution succeeds without a fresh install.
  await fs.symlink(ADAPTER_NODE_MODULES, path.join(tmp, "node_modules"), "dir");
  const buildDir = path.join(tmp, "build");
  await fs.mkdir(path.join(buildDir, "server"), { recursive: true });
  await fs.mkdir(path.join(buildDir, "client", "_app", "immutable"), { recursive: true });
  await fs.mkdir(path.join(buildDir, "prerendered"), { recursive: true });

  await fs.writeFile(path.join(buildDir, "server", "index.js"), STUB_SERVER);
  await fs.writeFile(path.join(buildDir, "manifest.js"), STUB_MANIFEST_JS);
  await fs.writeFile(path.join(buildDir, "client", "marker.txt"), "client-marker");
  await fs.writeFile(
    path.join(buildDir, "client", "_app", "immutable", "chunk.js"),
    "// hashed",
  );
  await fs.writeFile(path.join(buildDir, "prerendered", "about.html"), "<h1>about</h1>");

  // /nested/ with index.html exercises the directory fallback.
  await fs.mkdir(path.join(buildDir, "prerendered", "nested"), { recursive: true });
  await fs.writeFile(path.join(buildDir, "prerendered", "nested", "index.html"), "<h1>nested</h1>");

  if (fallback) {
    await fs.writeFile(
      path.join(buildDir, "prerendered", fallback),
      `<!doctype html><html><body data-shell="${fallback}">spa fallback shell</body></html>`,
    );
  }

  const template = await fs.readFile(path.join(ENTRY_SRC_DIR, `${runtime}.js`), "utf8");
  const entry = template
    .replace(/__CREEK_PORT__/g, String(port))
    .replace(/__CREEK_HEALTH__/g, JSON.stringify(healthPath))
    .replace(/__CREEK_FALLBACK__/g, fallback ? JSON.stringify(fallback) : "null");
  await fs.writeFile(path.join(buildDir, "index.js"), entry);

  // The entry imports `./runtime.js` (which transitively imports
  // ./cache-handler.js) — mirror what adapt() does in production.
  for (const f of RUNTIME_FILES) {
    await fs.copyFile(path.join(ADAPTER_DIST_DIR, f), path.join(buildDir, f));
  }

  return tmp;
}

async function pickPort(): Promise<number> {
  // OS-assigned: bind on :0 then read .address().port. Avoids the
  // race of "guess a high port" on parallel test runs.
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
      } else {
        reject(new Error("could not get port"));
      }
    });
  });
}

async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(50);
  }
  throw new Error(`server not ready at ${url}: ${lastErr}`);
}

async function spawnEntry(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stdio so the test process can exit cleanly.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (b) => process.stderr.write(`  [child:${cmd}] ${b}`));
  return child;
}

async function shutdown(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

interface Harness {
  tmp: string;
  child: ChildProcess;
  base: string;
}

async function bringUp(
  runtime: "node" | "bun",
  extraEnv: NodeJS.ProcessEnv = {},
  fallback: string | null = null,
): Promise<Harness> {
  const port = await pickPort();
  const tmp = await buildSyntheticTree(runtime, port, "/_creek/health", fallback);

  const cmd = runtime === "node" ? process.execPath : "bun";
  const args = runtime === "node" ? ["build/index.js"] : ["run", "build/index.js"];
  const child = await spawnEntry(cmd, args, tmp, {
    PORT: String(port),
    HOST: "127.0.0.1",
    ...extraEnv,
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(`${base}/_creek/health`);
  } catch (err) {
    await shutdown(child);
    throw err;
  }
  return { tmp, child, base };
}

async function tearDown(h: Harness): Promise<void> {
  await shutdown(h.child);
  await fs.rm(h.tmp, { recursive: true, force: true });
}

function describeRuntime(runtime: "node" | "bun", available: boolean): void {
  const d = available ? describe : describe.skip;
  d(`entry: ${runtime}`, () => {
    let h: Harness;

    beforeAll(async () => {
      h = await bringUp(runtime);
    }, 30_000);

    afterAll(async () => {
      if (h) await tearDown(h);
    });

    it("health probe returns 200 ok", async () => {
      const res = await fetch(`${h.base}/_creek/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("content-type")).toContain("text/plain");
    });

    it("serves client assets", async () => {
      const res = await fetch(`${h.base}/marker.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("client-marker");
    });

    it("serves hashed client assets with immutable cache header", async () => {
      const res = await fetch(`${h.base}/_app/immutable/chunk.js`);
      expect(res.status).toBe(200);
      const cc = res.headers.get("cache-control") ?? "";
      expect(cc).toContain("immutable");
      expect(cc).toContain("max-age=31536000");
    });

    it("serves prerendered HTML at exact path", async () => {
      const res = await fetch(`${h.base}/about.html`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>about</h1>");
    });

    it("serves prerendered HTML when extension is omitted", async () => {
      const res = await fetch(`${h.base}/about`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>about</h1>");
    });

    it("serves prerendered directory index.html", async () => {
      const res = await fetch(`${h.base}/nested/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>nested</h1>");
    });

    it("hands unknown paths off to SvelteKit Server.respond", async () => {
      const res = await fetch(`${h.base}/anything`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ssr-default");
      expect(res.headers.get("x-handled-by")).toBe("stub");
    });

    it("forwards request method correctly", async () => {
      const res = await fetch(`${h.base}/echo-method`, { method: "PUT" });
      expect(await res.text()).toBe("PUT");
    });

    it("forwards POST body to the server", async () => {
      const res = await fetch(`${h.base}/echo-body`, {
        method: "POST",
        body: "hello-from-test",
        headers: { "content-type": "text/plain" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-from-test");
    });

    it("forwards request headers verbatim", async () => {
      const res = await fetch(`${h.base}/echo-header`, {
        headers: { "x-test": "headervalue" },
      });
      expect(await res.text()).toBe("headervalue");
    });

    it("returns socket address when ADDRESS_HEADER is unset (default)", async () => {
      // Auto-trusting X-Forwarded-For is a spoofing vector when no upstream
      // sanitises it. adapter-node behaves the same way: opt-in via
      // ADDRESS_HEADER, otherwise socket.remoteAddress.
      const res = await fetch(`${h.base}/echo-header`, {
        headers: { "x-test": "x", "x-forwarded-for": "203.0.113.5" },
      });
      const addr = res.headers.get("x-client-address") ?? "";
      expect(addr).not.toBe("203.0.113.5");
      // loopback may render as "127.0.0.1" or "::ffff:127.0.0.1" depending on dual-stack
      expect(addr.includes("127.0.0.1") || addr === "::1" || addr === "127.0.0.1").toBe(true);
    });

    it("exposes proxied client IP when ADDRESS_HEADER is set", async () => {
      const proxyAddrHarness = await bringUp(runtime, {
        ADDRESS_HEADER: "x-forwarded-for",
      });
      try {
        const res = await fetch(`${proxyAddrHarness.base}/echo-header`, {
          headers: { "x-test": "x", "x-forwarded-for": "203.0.113.5" },
        });
        expect(res.headers.get("x-client-address")).toBe("203.0.113.5");
      } finally {
        await tearDown(proxyAddrHarness);
      }
    });

    it("uses XFF_DEPTH to pick the right hop from chained x-forwarded-for", async () => {
      const depthHarness = await bringUp(runtime, {
        ADDRESS_HEADER: "x-forwarded-for",
        XFF_DEPTH: "2",
      });
      try {
        const res = await fetch(`${depthHarness.base}/echo-header`, {
          headers: { "x-test": "x", "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2" },
        });
        // depth=2 means "trust 2 hops" so pick (length - 2) = index 1
        expect(res.headers.get("x-client-address")).toBe("10.0.0.1");
      } finally {
        await tearDown(depthHarness);
      }
    });

    it("preserves response status codes", async () => {
      const res = await fetch(`${h.base}/status-418`);
      expect(res.status).toBe(418);
      expect(await res.text()).toBe("teapot");
    });

    it("streams chunked responses", async () => {
      const res = await fetch(`${h.base}/stream`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("chunk-1|chunk-2");
    });

    it("rewrites event.url from PROTOCOL_HEADER + HOST_HEADER (X-Forwarded-*)", async () => {
      // This test reuses the default harness — but to exercise the
      // proxy-aware path we need a second harness configured with the
      // header overrides. We bring one up inline.
      const proxyHarness = await bringUp(runtime, {
        PROTOCOL_HEADER: "x-forwarded-proto",
        HOST_HEADER: "x-forwarded-host",
      });
      try {
        const res = await fetch(`${proxyHarness.base}/echo-url`, {
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "app.example.com",
          },
        });
        expect(res.status).toBe(200);
        const seenUrl = await res.text();
        expect(seenUrl).toMatch(/^https:\/\/app\.example\.com\//);
      } finally {
        await tearDown(proxyHarness);
      }
    });

    it("uses ORIGIN env var as the canonical base when set", async () => {
      const originHarness = await bringUp(runtime, {
        ORIGIN: "https://canonical.example.com",
      });
      try {
        const res = await fetch(`${originHarness.base}/echo-url`);
        expect(res.status).toBe(200);
        const seenUrl = await res.text();
        expect(seenUrl).toMatch(/^https:\/\/canonical\.example\.com\//);
      } finally {
        await tearDown(originHarness);
      }
    });

    it("returns 413 when POST body exceeds BODY_SIZE_LIMIT", async () => {
      const limitHarness = await bringUp(runtime, {
        BODY_SIZE_LIMIT: "1024",
      });
      try {
        const big = "x".repeat(4096);
        const res = await fetch(`${limitHarness.base}/echo-body`, {
          method: "POST",
          body: big,
          headers: { "content-type": "text/plain" },
        });
        expect(res.status).toBe(413);
      } finally {
        await tearDown(limitHarness);
      }
    });

    it("fires sveltekit:shutdown listener on SIGTERM", async () => {
      const sentinel = path.join(os.tmpdir(), `creek-shutdown-${runtime}-${Date.now()}.txt`);
      const shHarness = await bringUp(runtime);
      try {
        const installRes = await fetch(
          `${shHarness.base}/install-shutdown-listener?file=${encodeURIComponent(sentinel)}`,
        );
        expect(await installRes.text()).toBe("listener-installed");

        // Send SIGTERM; the entry should fire sveltekit:shutdown then exit.
        shHarness.child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5_000);
          shHarness.child.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });

        const written = await fs.readFile(sentinel, "utf8").catch(() => "");
        expect(written).toBe("shutdown:SIGTERM");
      } finally {
        await fs.rm(shHarness.tmp, { recursive: true, force: true });
        await fs.rm(sentinel, { force: true });
      }
    });

    it("exposes platform.cache to user code", async () => {
      const res = await fetch(`${h.base}/cache/has`);
      expect(await res.text()).toBe("yes");
    });

    it("platform.cache round-trips simple set/get", async () => {
      await fetch(`${h.base}/cache/set?key=alpha&value=hello`);
      const got = await fetch(`${h.base}/cache/get?key=alpha`);
      expect(await got.text()).toBe("hello");
    });

    it("platform.cache.cached() memoizes the loader", async () => {
      const r1 = await fetch(`${h.base}/cache/cached?key=memo1`);
      const v1 = await r1.text();
      const r2 = await fetch(`${h.base}/cache/cached?key=memo1`);
      const v2 = await r2.text();
      expect(v1).toBe(v2);
      expect(v1).toMatch(/^loaded-\d+$/);
    });

    it("platform.cache tag invalidation makes entries stale", async () => {
      await fetch(`${h.base}/cache/set-tagged?key=t1&value=fresh&tag=group-a`);
      expect(await (await fetch(`${h.base}/cache/get?key=t1`)).text()).toBe("fresh");
      await new Promise((r) => setTimeout(r, 5)); // ensure timestamp moves
      await fetch(`${h.base}/cache/invalidate-tag?tag=group-a`);
      expect(await (await fetch(`${h.base}/cache/get?key=t1`)).text()).toBe("MISS");
    });

    it("platform.cache survives a process restart (L2 persistence)", async () => {
      // Use a stable cache dir + key so the second harness sees the
      // value the first one wrote.
      const cacheDir = path.join(os.tmpdir(), `creek-cache-${runtime}-${Date.now()}`);
      const first = await bringUp(runtime, { CREEK_SVELTE_CACHE_DIR: cacheDir });
      try {
        await fetch(`${first.base}/cache/set?key=persist&value=survived`);
      } finally {
        await tearDown(first);
      }

      const second = await bringUp(runtime, { CREEK_SVELTE_CACHE_DIR: cacheDir });
      try {
        const res = await fetch(`${second.base}/cache/get?key=persist`);
        expect(await res.text()).toBe("survived");
      } finally {
        await tearDown(second);
        await fs.rm(cacheDir, { recursive: true, force: true });
      }
    });

    it("rejects path traversal attempts", async () => {
      // /..%2Fserver%2Findex.js -> decoded: /../server/index.js
      const res = await fetch(`${h.base}/..%2Fserver%2Findex.js`);
      // Either resolved as 200 ssr-default (handed off) or 404; the
      // critical thing is we don't 200 the server/index.js content.
      const body = await res.text();
      expect(body).not.toContain("class Server");
    });
  });
}

async function bunAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn("bun", ["--version"], { stdio: "ignore" });
    c.once("error", () => resolve(false));
    c.once("exit", (code) => resolve(code === 0));
  });
}

describeRuntime("node", true);

// Bun is detected at module-eval time. Using describe.skip when missing
// keeps the suite green on hosts without Bun (CI matrix can opt in).
const hasBun = await bunAvailable();
describeRuntime("bun", hasBun);

// SPA fallback: a dedicated harness per runtime — the entry's FALLBACK
// constant is baked in at template-substitution time, so we cannot
// flip it on an already-running server.
function describeFallback(
  runtime: "node" | "bun",
  available: boolean,
  fallback: string,
  expectedStatus: number,
): void {
  const d = available ? describe : describe.skip;
  d(`entry: ${runtime} (fallback=${fallback})`, () => {
    let h: Harness;

    beforeAll(async () => {
      h = await bringUp(runtime, {}, fallback);
    }, 30_000);

    afterAll(async () => {
      if (h) await tearDown(h);
    });

    it(`serves fallback HTML on SSR 404 with status ${expectedStatus}`, async () => {
      const res = await fetch(`${h.base}/will-404`);
      expect(res.status).toBe(expectedStatus);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const body = await res.text();
      expect(body).toContain("spa fallback shell");
      expect(body).toContain(`data-shell="${fallback}"`);
    });

    it("does not override a 200 SSR response with the fallback", async () => {
      const res = await fetch(`${h.base}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("ssr-default");
    });

    it("does not override a 418 SSR response with the fallback", async () => {
      const res = await fetch(`${h.base}/status-418`);
      expect(res.status).toBe(418);
    });

    it("prerendered hits still win over fallback", async () => {
      const res = await fetch(`${h.base}/about`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>about</h1>");
    });
  });
}

describeFallback("node", true, "200.html", 200);
describeFallback("node", true, "404.html", 404);
describeFallback("bun", hasBun, "200.html", 200);
describeFallback("bun", hasBun, "404.html", 404);
