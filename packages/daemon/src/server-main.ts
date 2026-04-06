#!/usr/bin/env node

import { getRequestListener } from "@hono/node-server";
import { Layer, ManagedRuntime } from "effect";
import { createServer } from "node:http";
import { createApp } from "./server.ts";
import { DaemonService } from "./services/daemon-service.ts";
import { ensureDir, saveDaemonPid, saveRuntimeMetadata } from "./state/global-state.ts";

async function main() {
  ensureDir();
  saveDaemonPid(process.pid);

  const port = Number.parseInt(process.env.SPAWNTREE_PORT ?? "2222", 10) || 2222;
  const runtime = ManagedRuntime.make(DaemonService.layer, {
    memoMap: Layer.makeMemoMapUnsafe(),
  });

  const app = createApp(runtime);
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

  const shutdown = async (signal: string) => {
    process.stderr.write(`[spawntree-daemon] Received ${signal}, shutting down...\n`);
    try {
      await runtime.runPromise(DaemonService.use((service) => service.shutdown));
    } catch {
      // best effort
    }
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `[spawntree-daemon] Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
