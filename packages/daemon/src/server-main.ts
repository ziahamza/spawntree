#!/usr/bin/env node

import { getRequestListener } from "@hono/node-server";
import { Layer, ManagedRuntime, Match } from "effect";
import { createServer } from "node:http";
import { createApp, hasBundledWebApp } from "./server.ts";
import { DaemonService } from "./services/daemon-service.ts";
import { SessionManager } from "./sessions/session-manager.ts";
import { ensureDir, saveDaemonPid, saveRuntimeMetadata } from "./state/global-state.ts";

async function main() {
  ensureDir();
  saveDaemonPid(process.pid);

  const port = Number.parseInt(process.env.SPAWNTREE_PORT ?? "2222", 10) || 2222;
  const runtime = ManagedRuntime.make(DaemonService.layer, {
    memoMap: Layer.makeMemoMapUnsafe(),
  });

  // Build the DomainEvents instance from the runtime so SessionManager can
  // publish into the same bus the existing /api/v1/events SSE stream uses.
  const domainEvents = await runtime.runPromise(
    DaemonService.use((service) => service.domainEvents),
  );
  const sessionManager = new SessionManager(domainEvents);

  const app = createApp(runtime, sessionManager);
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
