// @solcreek/svelte-adapter — Node entry.
// Placeholders __CREEK_PORT__ and __CREEK_HEALTH__ are substituted by
// src/adapt.ts before this file is written into the user's build dir.
//
// Layout assumed:
//   ./server/index.js   -> SvelteKit Server class as default
//   ./manifest.js       -> { manifest, prerendered }
//   ./client/           -> hashed client assets
//   ./prerendered/      -> prerendered HTML / JSON

// The polyfill registers Web globals (File, FormData, Request body
// streaming details) SvelteKit relies on. Modern Node has fetch/Request
// natively but the polyfill harmonises corner cases.
import "@sveltejs/kit/node/polyfills";

import { createServer } from "node:http";
import { existsSync, statSync, createReadStream, readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequest, setResponse } from "@sveltejs/kit/node";

import { Server } from "./server/index.js";
import { manifest } from "./manifest.js";
// Runtime modules are copied next to this entry at adapt time so the
// build output is self-contained — no @solcreek/* dep needed on target.
import { createCache } from "./runtime.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_DIR = resolve(ROOT, "client");
const SERVER_DIR = resolve(ROOT, "server");
const PRERENDERED_DIR = resolve(ROOT, "prerendered");

const PORT = Number(process.env.PORT) || __CREEK_PORT__;
const HOST = process.env.HOST || "0.0.0.0";
const HEALTH_PATH = __CREEK_HEALTH__;
// SPA / catch-all HTML filename inside PRERENDERED_DIR, or null when disabled.
const FALLBACK = __CREEK_FALLBACK__;
// Convention from adapter-static / adapter-cloudflare: 404.html → 404,
// 200.html / index.html / anything-else → 200.
const FALLBACK_STATUS = FALLBACK && FALLBACK.endsWith("404.html") ? 404 : 200;
const IMMUTABLE_PREFIX = manifest.appPath ? `/${manifest.appPath}/immutable/` : "/_app/immutable/";

// Proxy / origin handling — creekd dispatch terminates in front of this
// process, so by default request.url has the loopback host. These envs
// let the operator tell us the true origin / client address.
const ORIGIN = process.env.ORIGIN || null;
const PROTOCOL_HEADER = (process.env.PROTOCOL_HEADER || "").toLowerCase() || null;
const HOST_HEADER = (process.env.HOST_HEADER || "").toLowerCase() || null;
const PORT_HEADER = (process.env.PORT_HEADER || "").toLowerCase() || null;
const ADDRESS_HEADER = (process.env.ADDRESS_HEADER || "").toLowerCase() || null;
const XFF_DEPTH = Math.max(1, Number(process.env.XFF_DEPTH) || 1);
const BODY_SIZE_LIMIT = Number(process.env.BODY_SIZE_LIMIT) || 524_288; // 512 KB
const SHUTDOWN_TIMEOUT_MS = (Number(process.env.SHUTDOWN_TIMEOUT) || 30) * 1_000;

// platform.cache: persistent KV exposed to user code via event.platform.
// Lives under CREEK_SVELTE_CACHE_DIR (default ".creek/svelte-cache" relative
// to the process cwd). Set CREEK_SVELTE_CACHE_DISABLED=1 to force in-memory.
const cache = createCache({
  dir: process.env.CREEK_SVELTE_CACHE_DIR,
  l1Entries: Number(process.env.CREEK_SVELTE_CACHE_L1) || undefined,
  inMemoryOnly: process.env.CREEK_SVELTE_CACHE_DISABLED === "1",
  driver: process.env.CREEK_SVELTE_CACHE_DRIVER,
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const server = new Server(manifest);
await server.init({
  env: process.env,
  read: (file) => readFileSync(join(SERVER_DIR, file)),
});

function resolveStaticFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const candidate = resolve(root, "." + decoded);
  if (candidate !== root && !candidate.startsWith(root + "/")) return null;
  if (!existsSync(candidate)) return null;

  const stat = statSync(candidate);
  if (stat.isFile()) return { path: candidate, size: stat.size };
  if (stat.isDirectory()) {
    const indexFile = join(candidate, "index.html");
    if (existsSync(indexFile)) {
      const idxStat = statSync(indexFile);
      if (idxStat.isFile()) return { path: indexFile, size: idxStat.size };
    }
  }
  return null;
}

function resolvePrerendered(urlPath) {
  const direct = resolveStaticFile(PRERENDERED_DIR, urlPath);
  if (direct) return direct;
  if (urlPath !== "/" && !urlPath.endsWith("/")) {
    const withHtml = resolveStaticFile(PRERENDERED_DIR, urlPath + ".html");
    if (withHtml) return withHtml;
  }
  return null;
}

function serveStatic(res, file, opts) {
  res.statusCode = 200;
  const ct = MIME[extname(file.path).toLowerCase()];
  if (ct) res.setHeader("content-type", ct);
  res.setHeader("content-length", String(file.size));
  if (opts?.immutable) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  }
  const stream = createReadStream(file.path);
  stream.on("error", () => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
  stream.pipe(res);
}

function headerValue(req, name) {
  if (!name) return null;
  const v = req.headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(",") : v;
}

function pickFromList(headerVal, depth) {
  if (!headerVal) return "";
  const parts = headerVal.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const idx = Math.max(0, parts.length - depth);
  return parts[idx];
}

function originFor(req) {
  if (ORIGIN) return ORIGIN;
  const proto = (PROTOCOL_HEADER && headerValue(req, PROTOCOL_HEADER))
    || (req.socket.encrypted ? "https" : "http");
  const hostHeader = (HOST_HEADER && headerValue(req, HOST_HEADER))
    || req.headers.host
    || `${HOST}:${PORT}`;
  const portFromHeader = PORT_HEADER ? headerValue(req, PORT_HEADER) : null;
  const portSuffix = portFromHeader && !hostHeader.includes(":") ? `:${portFromHeader}` : "";
  return `${proto}://${hostHeader}${portSuffix}`;
}

function clientAddressFor(req) {
  if (ADDRESS_HEADER) {
    return pickFromList(headerValue(req, ADDRESS_HEADER), XFF_DEPTH);
  }
  return req.socket.remoteAddress ?? "";
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://internal");

    if (url.pathname === HEALTH_PATH) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    const clientHit = resolveStaticFile(CLIENT_DIR, url.pathname);
    if (clientHit) {
      serveStatic(res, clientHit, {
        immutable: url.pathname.startsWith(IMMUTABLE_PREFIX),
      });
      return;
    }

    const prerenderedHit = resolvePrerendered(url.pathname);
    if (prerenderedHit) {
      serveStatic(res, prerenderedHit);
      return;
    }

    // Note: getRequest returns synchronously-shaped Request whose body
    // is a lazy stream. The 413 (body-too-large) error therefore fires
    // *inside* server.respond when SvelteKit consumes the body — not at
    // getRequest call time. Both call sites are wrapped together below.
    let response;
    try {
      const request = await getRequest({
        request: req,
        base: originFor(req),
        bodySizeLimit: BODY_SIZE_LIMIT,
      });
      response = await server.respond(request, {
        platform: { cache },
        getClientAddress: () => clientAddressFor(req),
      });
    } catch (err) {
      const status = (err && typeof err === "object" && typeof err.status === "number")
        ? err.status
        : null;
      if (status !== null) {
        res.statusCode = status;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(typeof err.text === "string" ? err.text : "");
        return;
      }
      throw err;
    }

    // SPA fallback: serve the static shell on any SSR 404 so the
    // client-side router can take over (or so a custom 404.html
    // surfaces a styled error page).
    if (FALLBACK && response.status === 404) {
      const fallbackFile = resolveStaticFile(PRERENDERED_DIR, "/" + FALLBACK);
      if (fallbackFile) {
        res.statusCode = FALLBACK_STATUS;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("content-length", String(fallbackFile.size));
        createReadStream(fallbackFile.path).pipe(res);
        return;
      }
    }

    await setResponse(res, response);
  } catch (err) {
    console.error("[creekd-svelte] request error", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }
    res.end("internal error");
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[creekd-svelte] node listening on ${HOST}:${PORT}`);
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[creekd-svelte] ${reason} received, draining`);

  // Fire sveltekit:shutdown so user code can close DB / flush queues
  // before we tear the socket down. We await every listener; if any
  // throws or hangs, the watchdog timer still forces exit.
  const listeners = process.listeners("sveltekit:shutdown");
  await Promise.all(
    listeners.map(async (l) => {
      try {
        await l(reason);
      } catch (err) {
        console.error("[creekd-svelte] sveltekit:shutdown listener error", err);
      }
    }),
  );

  // Flush in-flight cache writes before the socket closes — otherwise
  // a SIGTERM mid-revalidate can leave .tmp files behind.
  await cache.close().catch((err) => {
    console.error("[creekd-svelte] cache.close error", err);
  });

  httpServer.close(() => process.exit(0));
  setTimeout(() => {
    console.warn(`[creekd-svelte] graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
