// @solcreek/svelte-adapter — Bun entry.
// Placeholders __CREEK_PORT__ and __CREEK_HEALTH__ are substituted by
// src/adapt.ts before this file is written.

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "./server/index.js";
import { manifest } from "./manifest.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CLIENT_DIR = resolve(ROOT, "client");
const SERVER_DIR = resolve(ROOT, "server");
const PRERENDERED_DIR = resolve(ROOT, "prerendered");

const PORT = Number(process.env.PORT) || __CREEK_PORT__;
const HOST = process.env.HOST || "0.0.0.0";
const HEALTH_PATH = __CREEK_HEALTH__;
const IMMUTABLE_PREFIX = manifest.appPath ? `/${manifest.appPath}/immutable/` : "/_app/immutable/";

const ORIGIN = process.env.ORIGIN || null;
const PROTOCOL_HEADER = (process.env.PROTOCOL_HEADER || "").toLowerCase() || null;
const HOST_HEADER = (process.env.HOST_HEADER || "").toLowerCase() || null;
const PORT_HEADER = (process.env.PORT_HEADER || "").toLowerCase() || null;
const ADDRESS_HEADER = (process.env.ADDRESS_HEADER || "").toLowerCase() || null;
const XFF_DEPTH = Math.max(1, Number(process.env.XFF_DEPTH) || 1);
const BODY_SIZE_LIMIT = Number(process.env.BODY_SIZE_LIMIT) || 524_288;
const SHUTDOWN_TIMEOUT_MS = (Number(process.env.SHUTDOWN_TIMEOUT) || 30) * 1_000;

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
  if (stat.isFile()) return candidate;
  if (stat.isDirectory()) {
    const indexFile = join(candidate, "index.html");
    if (existsSync(indexFile) && statSync(indexFile).isFile()) return indexFile;
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

function staticResponse(filePath, opts) {
  const headers = new Headers();
  if (opts?.immutable) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  const ct = extname(filePath).toLowerCase();
  if (ct === ".woff" || ct === ".woff2") {
    headers.set("content-type", ct === ".woff" ? "font/woff" : "font/woff2");
  }
  return new Response(Bun.file(filePath), { headers });
}

function pickFromList(headerVal, depth) {
  if (!headerVal) return "";
  const parts = headerVal.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  return parts[Math.max(0, parts.length - depth)];
}

function rewriteUrl(request) {
  if (ORIGIN) {
    const u = new URL(request.url);
    const o = new URL(ORIGIN);
    return new URL(u.pathname + u.search + u.hash, o.origin).toString();
  }
  const u = new URL(request.url);
  if (PROTOCOL_HEADER) {
    const v = request.headers.get(PROTOCOL_HEADER);
    if (v) u.protocol = v + ":";
  }
  if (HOST_HEADER) {
    const v = request.headers.get(HOST_HEADER);
    if (v) {
      // Clear the loopback port BEFORE applying the forwarded host —
      // otherwise WHATWG URL leaves the original port glued on when the
      // new host string has no explicit ":port".
      u.port = "";
      if (v.includes(":")) u.host = v;
      else u.hostname = v;
    }
  }
  if (PORT_HEADER) {
    const v = request.headers.get(PORT_HEADER);
    if (v) u.port = v;
  }
  return u.toString();
}

function clientAddressFor(request, fallback) {
  // Match adapter-node: only trust forwarded-for-style headers when the
  // operator explicitly opts in via ADDRESS_HEADER. Auto-trusting
  // X-Forwarded-For is a spoofing vector when no upstream sanitises it.
  if (ADDRESS_HEADER) {
    return pickFromList(request.headers.get(ADDRESS_HEADER), XFF_DEPTH);
  }
  return fallback ?? "";
}

const httpServer = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(request, srv) {
    try {
      const url = new URL(request.url);

      if (url.pathname === HEALTH_PATH) {
        return new Response("ok", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        const cl = Number(request.headers.get("content-length") || 0);
        if (cl > 0 && cl > BODY_SIZE_LIMIT) {
          return new Response("Payload Too Large", {
            status: 413,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      }

      const clientHit = resolveStaticFile(CLIENT_DIR, url.pathname);
      if (clientHit) {
        return staticResponse(clientHit, {
          immutable: url.pathname.startsWith(IMMUTABLE_PREFIX),
        });
      }

      const prerenderedHit = resolvePrerendered(url.pathname);
      if (prerenderedHit) return staticResponse(prerenderedHit);

      // Rewrite request URL with canonical origin (for X-Forwarded-* support).
      const canonical = rewriteUrl(request);
      const finalRequest = canonical === request.url
        ? request
        : new Request(canonical, request);

      const srvAddr = srv.requestIP(request)?.address;
      return await server.respond(finalRequest, {
        platform: {},
        getClientAddress: () => clientAddressFor(request, srvAddr),
      });
    } catch (err) {
      console.error("[creekd-svelte] request error", err);
      return new Response("internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
});

console.log(`[creekd-svelte] bun listening on ${httpServer.hostname}:${httpServer.port}`);

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[creekd-svelte] ${reason} received, draining`);

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

  httpServer.stop();
  setTimeout(() => process.exit(0), 100).unref();
  setTimeout(() => {
    console.warn(`[creekd-svelte] graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
