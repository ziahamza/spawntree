#!/usr/bin/env node

import { getRequestListener } from "@hono/node-server";
import { Layer, ManagedRuntime, Match } from "effect";
import { createServer } from "node:http";
import { createApp, hasBundledWebApp } from "./server.ts";
import { DaemonService } from "./services/daemon-service.ts";
import { SessionManager } from "./sessions/session-manager.ts";
import { ensureDir, saveDaemonPid, saveRuntimeMetadata, spawntreeHome } from "./state/global-state.ts";
import { StorageManager } from "./storage/manager.ts";

async function main() {
  ensureDir();
  saveDaemonPid(process.pid);

  const port = Number.parseInt(process.env.SPAWNTREE_PORT ?? "2222", 10) || 2222;

  // StorageManager is the source of truth for the daemon's libSQL client.
  // Boot it BEFORE the DaemonService so the catalog can open against the
  // live primary (local, turso-embedded, or whatever the user configured in
  // ~/.spawntree/storage.json). This way the replicator loop snapshots the
  // real catalog DB, not an empty sidecar.
  const storage = new StorageManager({ dataDir: spawntreeHome() });
  await storage.start();

  const runtime = ManagedRuntime.make(DaemonService.makeLayer(storage), {
    memoMap: Layer.makeMemoMapUnsafe(),
  });

  // Build the DomainEvents instance from the runtime so SessionManager can
  // publish into the same bus the existing /api/v1/events SSE stream uses.
  // SessionManager also persists session metadata through the same
  // StorageManager client so sessions land in the replicated catalog DB.
  const domainEvents = await runtime.runPromise(
    DaemonService.use((service) => service.domainEvents),
  );
  const sessionManager = new SessionManager(domainEvents, { storage });
  await sessionManager.start();

  // Background discovery: every N seconds, ask each adapter what sessions
  // exist and mirror them into the catalog. Without this, sessions started
  // outside the daemon (e.g. `codex exec ...` from a terminal) never make
  // it into the `sessions` table that Studio + the s3-snapshot replicator
  // read from. Cadence is configurable via SPAWNTREE_DISCOVERY_INTERVAL_MS;
  // set to 0 to disable the loop entirely (useful for tests).
  const discoveryIntervalMs = Number.parseInt(
    process.env.SPAWNTREE_DISCOVERY_INTERVAL_MS ?? "30000",
    10,
  );
  if (discoveryIntervalMs > 0) {
    sessionManager.startDiscoveryLoop(discoveryIntervalMs);
  }

  const app = createApp(runtime, { storage, sessionManager });
  const listener = getRequestListener(app.fetch);
  const server = createServer(listener);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  saveRuntimeMetadata({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    httpPort: port,
  });

  const origin = `http://127.0.0.1:${port}`;
  process.stderr.write(`[spawntree-daemon] API: ${origin}/api/v1/daemon\n`);
  if (hasBundledWebApp()) {
    process.stderr.write(`[spawntree-daemon] Web: ${origin}/\n`);
  } else {
    process.stderr.write(
      "[spawntree-daemon] Web bundle not found. Run `pnpm build` to serve the UI from the daemon.\n",
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) =>
    Match.value(shuttingDown).pipe(
      Match.when(true, () => undefined),
      Match.orElse(async () => {
        shuttingDown = true;
        process.stderr.write(`[spawntree-daemon] Received ${signal}, shutting down...\n`);
        // Tear down the session manager first so ACP adapter subprocesses
        // release before the runtime disposes the services they might use.
        await sessionManager.shutdown().catch(() => undefined);
        await runtime
          .runPromise(DaemonService.use((service) => service.shutdown))
          .catch(() => undefined);
        await runtime.dispose();
        await storage.stop().catch(() => undefined);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        process.exit(0);
      }),
    );

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(`[spawntree-daemon] Fatal: ${formatFatalError(error)}\n`);
  process.exit(1);
});

function formatFatalError(error: unknown) {
  return Match.value(error).pipe(
    Match.when(Match.instanceOf(Error), (cause) => cause.stack ?? cause.message),
    Match.orElse((cause) => String(cause)),
  );
}
