#!/usr/bin/env node
import { createServer } from "node:http";
import { unlinkSync, existsSync } from "node:fs";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "./server.js";
import { EnvManager } from "./managers/env-manager.js";
import { PortRegistry } from "./managers/port-registry.js";
import { LogStreamer } from "./managers/log-streamer.js";
import {
  ensureDir,
  saveDaemonPid,
  socketPath,
} from "./state/global-state.js";

async function main() {
  ensureDir();
  saveDaemonPid(process.pid);

  const sock = socketPath();
  if (existsSync(sock)) {
    try { unlinkSync(sock); } catch { /* ignore */ }
  }

  const portRegistry = new PortRegistry();
  const logStreamer = new LogStreamer();
  const envManager = new EnvManager(portRegistry, logStreamer);
  const app = createApp(envManager, logStreamer, portRegistry);

  // Use raw Node http.createServer with Hono's request listener adapter
  // This supports Unix socket binding (serve() from @hono/node-server does not)
  const listener = getRequestListener(app.fetch);
  const server = createServer(listener);

  server.listen(sock, () => {
    process.stdout.write("READY\n");
    console.log(`[spawntree-daemon] Listening on ${sock}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[spawntree-daemon] Received ${signal}, shutting down...`);

    const envs = envManager.listEnvs();
    for (const env of envs) {
      try {
        await envManager.downEnv(env.repoId, env.envId);
      } catch (err) {
        console.error(`[spawntree-daemon] Error stopping ${env.envId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    server.close(() => {
      try { if (existsSync(sock)) unlinkSync(sock); } catch { /* ignore */ }
      console.log("[spawntree-daemon] Shutdown complete");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[spawntree-daemon] Fatal:", err);
  process.exit(1);
});
