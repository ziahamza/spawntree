#!/usr/bin/env node

import { getRequestListener } from "@hono/node-server";
import { Layer, ManagedRuntime, Match } from "effect";
import { createServer } from "node:http";
import { createApp, hasBundledWebApp } from "./server.ts";
import { DaemonService } from "./services/daemon-service.ts";
import { SessionManager } from "./sessions/session-manager.ts";
import { isHostKey, isHttpUrl, runServiceCommand } from "./service/install.ts";
import {
  clearHostBinding,
  ensureDir,
  type HostBinding,
  hostBindingPath,
  loadHostBinding,
  saveDaemonPid,
  saveHostBinding,
  saveRuntimeMetadata,
  spawntreeHome,
} from "./state/global-state.ts";
import { SandboxManager } from "./sandbox/manager.ts";
import { HostConfigSync } from "./storage/host-sync.ts";
import { StorageManager } from "./storage/manager.ts";

async function main() {
  // Service subcommands run + exit before booting the daemon. Bare
  // `spawntree-daemon` (no subcommand) runs the daemon as before.
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (sub === "install" || sub === "uninstall" || sub === "status") {
    await runServiceCommand(sub, argv.slice(1));
    return;
  }

  ensureDir();
  saveDaemonPid(process.pid);

  // Resolve the host binding before anything else: CLI args override the
  // persisted file, and if either CLI arg is present we write the pair to
  // disk so subsequent invocations pick it up automatically. To unbind a
  // daemon: `rm ~/.spawntree/host.json`.
  const hostBinding = resolveHostBinding(process.argv.slice(2));

  const port = Number.parseInt(process.env.SPAWNTREE_PORT ?? "2222", 10) || 2222;

  // StorageManager is the source of truth for the daemon's libSQL client.
  // Boot it before the DaemonService so the catalog can open against the
  // local SQLite file managed by Turso Sync's local engine.
  const storage = new StorageManager({ dataDir: spawntreeHome() });
  await storage.start();

  // Sandbox providers (Docker / Apple `container`). Boot after storage (it
  // owns the catalog client the manager persists into) and before the
  // SessionManager (which is wired to spawn agents into sandboxes via the
  // manager's `spawnerFor`). Re-adopts any sandboxes that survived a restart.
  const sandboxManager = new SandboxManager({ storage, dataDir: spawntreeHome() });
  await sandboxManager.start();

  // If a host binding is in effect, reconcile the managed sync config before
  // catalog DDL. Terminal host rejections abort startup; non-terminal missing
  // config leaves the current local sqlite catalog untouched while polling.
  let hostSync: HostConfigSync | null = null;
  if (hostBinding) {
    hostSync = createHostConfigSync(hostBinding, storage);
    await hostSync.refreshNow();
    const status = hostSync.getStatus();
    if (status.state === "error" && status.terminal) {
      throw new Error(status.error);
    }
  }

  const runtime = ManagedRuntime.make(DaemonService.makeLayer(storage), {
    memoMap: Layer.makeMemoMapUnsafe(),
  });

  // Build the DomainEvents instance from the runtime so SessionManager can
  // publish into the same bus the existing /api/v1/events SSE stream uses.
  // SessionManager also persists session metadata through the same
  // StorageManager client so sessions land in the local catalog DB and ride
  // whatever background sync method is configured.
  const domainEvents = await runtime.runPromise(
    DaemonService.use((service) => service.domainEvents),
  );
  const sessionManager = new SessionManager(domainEvents, { storage, sandboxManager });
  await sessionManager.start();
  void storage.syncNow().catch((error) => {
    process.stderr.write(
      `[spawntree-daemon] storage initial sync failed: ${formatFatalError(error)}\n`,
    );
  });

  // Background discovery: every N seconds, ask each adapter what sessions
  // exist and mirror them into the catalog. Without this, sessions started
  // outside the daemon (e.g. `codex exec ...` from a terminal) never make
  // it into the `sessions` table that Studio + background sync read from.
  // Cadence is configurable via SPAWNTREE_DISCOVERY_INTERVAL_MS;
  // set to 0 to disable the loop entirely (useful for tests).
  const discoveryIntervalMs = Number.parseInt(
    process.env.SPAWNTREE_DISCOVERY_INTERVAL_MS ?? "30000",
    10,
  );
  if (discoveryIntervalMs > 0) {
    sessionManager.startDiscoveryLoop(discoveryIntervalMs);
  }

  if (hostBinding) {
    hostSync?.start();
    process.stderr.write(
      `[spawntree-daemon] host: bound to ${hostBinding.url} (key dh_…${hostBinding.key.slice(-6)})\n`,
    );
  }

  const app = createApp(runtime, { storage, sessionManager, hostSync, sandboxManager });
  const listener = getRequestListener(app.fetch);
  // Wrap the listener so node:http sees a void-returning callback. The
  // underlying `listener` returns Promise<void> (Hono's async fetch), which
  // trips no-misused-promises. The wrapper has no behavioural effect — the
  // server still only cares that `res.end()` is eventually called.
  const server = createServer((req, res) => {
    void listener(req, res);
  });

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

  void runtime
    .runPromise(DaemonService.use((service) => service.rescanWatchedPaths))
    .catch((error) => {
      process.stderr.write(
        `[spawntree-daemon] watched path startup rescan failed: ${formatFatalError(error)}\n`,
      );
    });

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
        // Stop sandbox watchers (does NOT stop user containers — they
        // outlive a daemon restart and are re-adopted on next boot).
        await sandboxManager.stop().catch(() => undefined);
        await hostSync?.stop().catch(() => undefined);
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

function createHostConfigSync(hostBinding: HostBinding, storage: StorageManager): HostConfigSync {
  // SPAWNTREE_HOST_POLL_INTERVAL_MS: internal/test debugging knob — overrides
  // the default 5-minute poll interval. No CLI flag; env-only on purpose so
  // it stays an off-the-beaten-path debugging affordance.
  const pollIntervalMs = readPositiveIntEnv("SPAWNTREE_HOST_POLL_INTERVAL_MS");
  const requestTimeoutMs = readPositiveIntEnv("SPAWNTREE_HOST_REQUEST_TIMEOUT_MS", 30_000);

  // SPAWNTREE_FINGERPRINT_OVERRIDE: test-only escape hatch for the
  // wrong-fingerprint hard-error E2E. Production NEVER sets this — the
  // daemon reads its OS machine id via `node-machine-id`. Documented in
  // host-sync.ts.
  const fingerprintOverride = process.env.SPAWNTREE_FINGERPRINT_OVERRIDE;

  return new HostConfigSync({
    binding: hostBinding,
    manager: storage,
    fetch: createTimeoutFetch(requestTimeoutMs),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(fingerprintOverride ? { fingerprintOverride } : {}),
    // On 410 GONE (key revoked — machine removed on host): clear the
    // persisted binding so the next startup prompts re-registration
    // instead of looping on rejected requests indefinitely.
    onGone: () => {
      process.stderr.write(
        "[spawntree-daemon] host: daemon key revoked — clearing ~/.spawntree/host.json. " +
          "Re-register this machine on the host to continue.\n",
      );
      clearHostBinding();
    },
  });
}

function readPositiveIntEnv(name: string): number | undefined;
function readPositiveIntEnv(name: string, fallback: number): number;
function readPositiveIntEnv(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    process.stderr.write(`[spawntree-daemon] invalid ${name}: ${raw}\n`);
    process.exit(2);
  }
  return value;
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Resolve the host binding for this daemon invocation.
 *
 * Precedence:
 *   1. `--host <url> --host-key <dh_…>` on the CLI. If either is passed,
 *      both must be — and the pair is persisted to `~/.spawntree/host.json`
 *      (0600) so subsequent invocations don't need the args.
 *   2. `~/.spawntree/host.json` if it exists from a prior run.
 *   3. Nothing — daemon runs in standalone mode (the long-standing default).
 *
 * To unbind a daemon: `rm ~/.spawntree/host.json` and restart.
 */
function resolveHostBinding(argv: ReadonlyArray<string>): HostBinding | null {
  const cliHost = readFlag(argv, "--host");
  const cliKey = readFlag(argv, "--host-key");

  if (cliHost && cliKey) {
    const url = cliHost.replace(/\/+$/, "");
    if (!isHttpUrl(url)) {
      process.stderr.write(`[spawntree-daemon] --host must be an http(s) URL; got ${cliHost}\n`);
      process.exit(2);
    }
    if (!isHostKey(cliKey)) {
      process.stderr.write(
        `[spawntree-daemon] --host-key must look like dh_<token>; got a malformed value\n`,
      );
      process.exit(2);
    }
    const binding: HostBinding = { url, key: cliKey };
    saveHostBinding(binding);
    process.stderr.write(`[spawntree-daemon] host: persisted binding to ${hostBindingPath()}\n`);
    return binding;
  }

  // One arg without the other → user error, fail loud rather than ignore.
  if (cliHost && !cliKey) {
    process.stderr.write(`[spawntree-daemon] --host requires --host-key\n`);
    process.exit(2);
  }
  if (cliKey && !cliHost) {
    process.stderr.write(`[spawntree-daemon] --host-key requires --host\n`);
    process.exit(2);
  }

  // No CLI override — fall back to persisted file (or standalone).
  return loadHostBinding();
}

/** Read a `--flag value` or `--flag=value` from `argv`. Returns null if absent. */
function readFlag(argv: ReadonlyArray<string>, flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) {
      const next = argv[i + 1];
      return next ?? null;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return null;
}
