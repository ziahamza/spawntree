#!/usr/bin/env node
/**
 * Spawntree federation host server.
 *
 * Aggregates multiple spawntree daemons behind a single HTTP surface.
 * Stores the registry in a local SQLite file so restarts preserve the
 * host list. See ./README.md for usage.
 *
 * Pure Node.js. No framework, no deps beyond `better-sqlite3`.
 *
 * Run directly:
 *   pnpm --filter spawntree-host start
 *   HOST_SERVER_PORT=7777 npx spawntree-host
 *
 * Or install + invoke the bin:
 *   npm i -g spawntree-host
 *   spawntree-host
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import Database from "better-sqlite3";

// ─── Config ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.HOST_SERVER_PORT ?? 7777);
const HOST = process.env.HOST_SERVER_HOST ?? "127.0.0.1";
const DB_PATH = process.env.HOST_SERVER_DB ?? resolve(process.cwd(), "hosts.db");

// ─── Storage ────────────────────────────────────────────────────────────

interface HostRow {
  name: string;
  url: string;
  label: string | null;
  registeredAt: string;
  lastSeenAt: string | null;
}

function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      name          TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      label         TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at  TEXT
    );
  `);

  return {
    list(): HostRow[] {
      return db
        .prepare(
          `SELECT name, url, label, registered_at AS registeredAt, last_seen_at AS lastSeenAt
           FROM hosts ORDER BY name`,
        )
        .all() as HostRow[];
    },
    get(name: string): HostRow | undefined {
      return db
        .prepare(
          `SELECT name, url, label, registered_at AS registeredAt, last_seen_at AS lastSeenAt
           FROM hosts WHERE name = ?`,
        )
        .get(name) as HostRow | undefined;
    },
    upsert(name: string, url: string, label: string | null) {
      db.prepare(
        `INSERT INTO hosts (name, url, label, registered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, label = excluded.label`,
      ).run(name, url, label, new Date().toISOString());
      return this.get(name)!;
    },
    delete(name: string) {
      return db.prepare(`DELETE FROM hosts WHERE name = ?`).run(name).changes > 0;
    },
    touch(name: string) {
      db.prepare(`UPDATE hosts SET last_seen_at = ? WHERE name = ?`).run(
        new Date().toISOString(),
        name,
      );
    },
  };
}

const store = openStore(DB_PATH);

// ─── HTTP helpers ───────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // Dev-friendly CORS so the dashboard can call this from a dev server.
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function isValidName(name: string) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);
}

function isValidUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Admin handlers ─────────────────────────────────────────────────────

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // CORS preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,PATCH,PUT,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return true;
  }

  if (pathname === "/api/hosts" && req.method === "GET") {
    json(res, 200, { hosts: store.list() });
    return true;
  }

  if (pathname === "/api/hosts" && req.method === "POST") {
    try {
      const body = await readJson<{ name?: string; url?: string; label?: string }>(req);
      if (!body.name || !isValidName(body.name)) {
        json(res, 400, { error: "invalid or missing 'name'", code: "INVALID_NAME" });
        return true;
      }
      if (!body.url || !isValidUrl(body.url)) {
        json(res, 400, { error: "invalid or missing 'url'", code: "INVALID_URL" });
        return true;
      }
      // Label is user-supplied free text. Enforce a reasonable cap and
      // reject non-string values. Output is HTML-escaped on the landing
      // page too, but accepting 10MB strings or non-strings into SQLite
      // is still a bad idea.
      let label: string | null = null;
      if (body.label !== undefined && body.label !== null) {
        if (typeof body.label !== "string") {
          json(res, 400, { error: "'label' must be a string", code: "INVALID_LABEL" });
          return true;
        }
        if (body.label.length > 256) {
          json(res, 400, { error: "'label' too long (max 256 chars)", code: "INVALID_LABEL" });
          return true;
        }
        label = body.label;
      }
      const row = store.upsert(body.name, body.url, label);
      json(res, 201, { host: row });
    } catch {
      json(res, 400, { error: "invalid JSON body", code: "INVALID_JSON" });
    }
    return true;
  }

  const byNameMatch = /^\/api\/hosts\/([^/]+)$/.exec(pathname);
  if (byNameMatch) {
    const name = decodeURIComponent(byNameMatch[1]!);
    if (req.method === "GET") {
      const row = store.get(name);
      if (!row) {
        json(res, 404, { error: "not found", code: "HOST_NOT_FOUND" });
        return true;
      }
      json(res, 200, { host: row });
      return true;
    }
    if (req.method === "DELETE") {
      const removed = store.delete(name);
      json(
        res,
        removed ? 200 : 404,
        removed ? { ok: true } : { error: "not found", code: "HOST_NOT_FOUND" },
      );
      return true;
    }
  }

  const healthMatch = /^\/api\/hosts\/([^/]+)\/health$/.exec(pathname);
  if (healthMatch && req.method === "GET") {
    const name = decodeURIComponent(healthMatch[1]!);
    const row = store.get(name);
    if (!row) {
      json(res, 404, { error: "not found", code: "HOST_NOT_FOUND" });
      return true;
    }
    const ok = await probeHealth(row.url);
    if (ok) store.touch(name);
    json(res, 200, { name, url: row.url, reachable: ok });
    return true;
  }

  return false;
}

async function probeHealth(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const target = new URL("/health", baseUrl);
      const client = target.protocol === "https:" ? httpsRequest : httpRequest;
      const req = client(target, { method: "GET", timeout: 2_000 }, (upstream) => {
        // Drain so the socket can close.
        upstream.resume();
        resolve((upstream.statusCode ?? 500) < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ─── Proxy ──────────────────────────────────────────────────────────────

/**
 * Proxy using global fetch (Node 18+). Buffers the body for body-bearing
 * methods — demo-grade, fine for API calls, too simple for huge uploads.
 * Streams the response back via Web Streams so SSE still works.
 */
async function proxyToHost(
  req: IncomingMessage,
  res: ServerResponse,
  hostName: string,
  upstreamPath: string,
) {
  const host = store.get(hostName);
  if (!host) {
    json(res, 404, { error: `unknown host: ${hostName}`, code: "HOST_NOT_FOUND" });
    return;
  }

  const target = new URL(upstreamPath, host.url);
  const method = (req.method ?? "GET").toUpperCase();
  const bodyless =
    method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE";

  // Pass through headers minus hop-by-hop + our own host header.
  const forwardedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (
      key === "host" ||
      key === "connection" ||
      key === "content-length" ||
      key === "transfer-encoding" ||
      key === "keep-alive" ||
      key === "proxy-authenticate" ||
      key === "proxy-authorization" ||
      key === "te" ||
      key === "trailer" ||
      key === "upgrade"
    )
      continue;
    forwardedHeaders[key] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  forwardedHeaders["x-forwarded-host"] = req.headers.host ?? "";
  forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  forwardedHeaders["x-spawntree-host"] = hostName;

  // Buffer the body for non-GET methods. Keeps the control flow linear
  // and sidesteps the many subtle pipe/Transfer-Encoding races between
  // IncomingMessage and ClientRequest.
  let body: Buffer | undefined;
  if (!bodyless) {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve());
      req.on("error", reject);
    }).catch(() => {});
    body = Buffer.concat(chunks);
  }

  // Propagate client abort to the upstream fetch.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(target, {
      method,
      headers: forwardedHeaders,
      body: body && body.length > 0 ? body : undefined,
      signal: controller.signal,
      // `duplex` is a Node-specific fetch extension. Older lib.dom.d.ts
      // didn't know about it, but current TS + Node types do. If this
      // starts failing on your Node version, cast to `RequestInit &
      // { duplex: string }`.
      duplex: "half",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[spawntree-host] upstream fail: ${message} (${method} ${target.pathname})\n`,
    );
    if (!res.headersSent) {
      json(res, 502, {
        error: `upstream error: ${message}`,
        code: "UPSTREAM_UNREACHABLE",
        host: { name: hostName, url: host.url },
      });
    }
    return;
  }

  // Copy headers through. Add CORS for browser clients.
  const outHeaders: Record<string, string | string[]> = {};
  upstreamRes.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  outHeaders["access-control-allow-origin"] = "*";
  res.writeHead(upstreamRes.status, outHeaders);

  store.touch(hostName);

  // Stream the body through. fetch's Response.body is a Web ReadableStream.
  if (!upstreamRes.body) {
    res.end();
    return;
  }
  try {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch {
    // Client disconnect or upstream reset mid-stream — just close.
    if (!res.writableEnded) res.end();
  }
}

// ─── Router ─────────────────────────────────────────────────────────────

/**
 * HTML-escape a string for safe insertion into HTML text or attribute
 * contexts. Needed because `label` on a host row is user-supplied with
 * no validation (name is regex-validated, url is URL-validated, but
 * label is free-form) and is rendered back on the landing page — any
 * unescaped HTML there is stored XSS. Escape everything we interpolate
 * regardless of whether it's "already safe"; defense in depth beats
 * auditing which fields are user-influenced.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function landingPage(res: ServerResponse) {
  const hosts = store.list();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>spawntree host server</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#E6EDF3;background:#0D1117}
  h1{font-size:20px;margin-bottom:8px}
  p{color:#8B949E}
  pre{background:#161B22;padding:12px;border-radius:6px;overflow:auto}
  .host{background:#161B22;padding:12px;margin:8px 0;border-radius:6px;border:1px solid #30363D}
  .host b{color:#E6EDF3}
  .muted{color:#8B949E;font-size:12px}
  code{background:#161B22;padding:2px 6px;border-radius:3px}
  a{color:#58A6FF}
</style>
</head>
<body>
<h1>spawntree host server</h1>
<p>Listening on <code>${escapeHtml(HOST)}:${PORT}</code>. Registered hosts: ${hosts.length}.</p>
${
  hosts.length === 0
    ? "<p>No hosts registered yet.</p>"
    : hosts
        .map(
          (h) => `
  <div class="host">
    <b>${escapeHtml(h.name)}</b> → <code>${escapeHtml(h.url)}</code>
    ${h.label ? `<div class="muted">${escapeHtml(h.label)}</div>` : ""}
    <div class="muted">proxy: <a href="/h/${encodeURIComponent(h.name)}/api/v1/daemon">/h/${escapeHtml(
      h.name,
    )}/api/v1/daemon</a></div>
  </div>
`,
        )
        .join("")
}
<h2 style="font-size:16px;margin-top:24px">Register a host</h2>
<pre>curl -X POST http://${escapeHtml(HOST)}:${PORT}/api/hosts \\
  -H 'content-type: application/json' \\
  -d '{"name":"laptop","url":"http://127.0.0.1:2222"}'</pre>
<p><a href="/api/hosts">/api/hosts</a> — JSON list</p>
</body></html>`);
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;

  // Landing page — only for GET /.
  if (pathname === "/" && req.method === "GET") {
    return landingPage(res);
  }

  // Admin surface.
  if (pathname === "/api/hosts" || pathname.startsWith("/api/hosts/")) {
    const handled = await handleAdmin(req, res, pathname);
    if (handled) return;
  }

  // Proxy surface: /h/:name/<rest>
  const proxyMatch = /^\/h\/([^/]+)(\/.*)?$/.exec(pathname);
  if (proxyMatch) {
    const name = decodeURIComponent(proxyMatch[1]!);
    const rest = proxyMatch[2] ?? "/";
    // Preserve the full query string. RFC 3986 permits `?` inside
    // query values, so `split("?")` would truncate everything after a
    // second `?`. `slice(indexOf("?"))` keeps the tail intact.
    const qIdx = req.url!.indexOf("?");
    const upstreamPath = rest + (qIdx === -1 ? "" : req.url!.slice(qIdx));
    return proxyToHost(req, res, name, upstreamPath);
  }

  json(res, 404, { error: "not found", code: "NOT_FOUND" });
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`[spawntree-host] listening on http://${HOST}:${PORT} (db: ${DB_PATH})\n`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[spawntree-host] received ${signal}, shutting down\n`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
