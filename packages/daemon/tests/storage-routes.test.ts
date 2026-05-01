import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageManager } from "../src/storage/manager.ts";
import { createStorageRoutes } from "../src/routes/storage.ts";

/**
 * Cover the storage routes' CORS surface end-to-end.
 *
 * Studio (gitenv.dev) needs `GET /api/v1/storage` reachable from a public
 * origin so it can render the daemon's storage status in its Machine
 * detail page. The route had no CORS middleware before this fix, so any
 * browser at a non-same-origin location would fail the preflight (or the
 * actual GET would return without an `Access-Control-Allow-Origin`
 * header — also a CORS failure).
 *
 * Admin write methods (PUT/POST/DELETE) stay loopback-gated by the
 * existing `requireLocalOrigin` IP check — CORS opens the door for the
 * preflight, but the IP check still 403s actual mutations from a
 * non-loopback peer.
 */

describe("storage routes CORS", () => {
  let tmp: string;
  let storage: StorageManager;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-storage-cors-"));
    storage = new StorageManager({ dataDir: tmp, logger: () => undefined });
    await storage.start();

    const app = new Hono();
    app.route("/api/v1/storage", createStorageRoutes(storage));
    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await storage.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preflight from gitenv.dev returns 204 + ACAO + PNA echo", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/storage`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://gitenv.dev",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://gitenv.dev");
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    // Storage routes accept PUT (the catalog default doesn't), so confirm
    // it shows up in the allow-methods list.
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("GET / from gitenv.dev returns the status snapshot with ACAO", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/storage`, {
      method: "GET",
      headers: { Origin: "https://gitenv.dev" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://gitenv.dev");
    const body = (await res.json()) as { primary: { id: string }; replicators: unknown[] };
    expect(body.primary.id).toBe("local");
    expect(Array.isArray(body.replicators)).toBe(true);
  });

  it("preflight from an unknown origin returns 404 (no allow-list match)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/storage`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(404);
    // Without an ACAO header, the browser will block the response.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET / from an unknown origin returns 200 but WITHOUT ACAO (browser blocks)", async () => {
    // The handler still runs — it would for a same-origin GET — but the
    // CORS middleware doesn't add the ACAO echo. A real browser sees no
    // ACAO and rejects the response, which is the correct behavior for
    // an unknown origin: server doesn't lie about access being granted.
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/storage`, {
      method: "GET",
      headers: { Origin: "https://attacker.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("loopback origin (localhost dev Studio) is also allow-listed", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/storage`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
