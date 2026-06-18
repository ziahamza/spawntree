import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type {
  BindMount,
  CatalogDb,
  ProcessSpawner,
  Sandbox,
  SandboxContext,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  SandboxStatus,
  WorkspaceMode,
} from "spawntree-core";
import {
  loadSandboxConfig,
  sandboxes,
  SandboxRegistry,
  schema as catalogSchema,
} from "spawntree-core";
import { applyCatalogSchema } from "../catalog/queries.ts";
import type { StorageManager } from "../storage/manager.ts";
import { containerNameFor, errMessage, nowIso } from "./constants.ts";
import { defaultSandboxRegistry } from "./providers/registry.ts";

export interface SandboxManagerOptions {
  storage: StorageManager;
  dataDir: string;
  registry?: SandboxRegistry;
  logger?: SandboxContext["logger"];
}

interface ActiveProvider {
  provider: SandboxProvider;
  config: unknown; // validated per provider.configSchema is deferred; configs are all-optional
}

type SandboxRow = typeof sandboxes.$inferSelect;

function rowToSandbox(row: SandboxRow): Sandbox {
  return {
    id: row.id,
    providerId: row.providerId,
    runtimeId: row.runtimeId,
    // Catalog rows are spawntree-created, so the name is derivable and the
    // sandbox is always managed (external containers are never persisted).
    name: containerNameFor(row.id),
    managed: true,
    status: row.status as SandboxStatus,
    image: row.image,
    workspaceMode: row.workspaceMode as WorkspaceMode,
    mounts: (row.mounts ?? []) as BindMount[],
    labels: (row.labels ?? {}) as Record<string, string>,
    ephemeral: row.ephemeral === 1,
    repoId: row.repoId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Daemon-side orchestrator for sandboxes — the `StorageManager` analogue.
 * Loads the persisted config, activates the enabled+available providers,
 * tracks live `SandboxHandle`s, mirrors state into the `sandboxes` catalog
 * table, and bridges into the ACP layer via `spawnerFor(id)`.
 *
 * Built so a sandbox can be created standalone here OR (later) owned by an
 * env via `EnvManager`, without coupling to either.
 */
export class SandboxManager {
  private readonly client: Client;
  private readonly catalog: CatalogDb;
  private readonly dataDir: string;
  private readonly registry: SandboxRegistry;
  private readonly logger: SandboxContext["logger"];
  private readonly ctx: SandboxContext;
  /** Live handles for sandboxes this daemon currently manages, by sandbox id. */
  private readonly handles = new Map<string, SandboxHandle>();
  /** id → {providerId, runtimeId} learned from the last discovery, so ops can
   *  adopt a handle on demand for ANY container (incl. external ones). */
  private readonly discovered = new Map<string, { providerId: string; runtimeId: string }>();
  /** Enabled + configured providers, by provider id. */
  private readonly active = new Map<string, ActiveProvider>();
  private defaultProvider: string | undefined;

  constructor(options: SandboxManagerOptions) {
    this.client = options.storage.client;
    this.catalog = drizzle(this.client, { schema: catalogSchema });
    this.dataDir = options.dataDir;
    this.registry = options.registry ?? defaultSandboxRegistry();
    this.logger =
      options.logger ??
      ((level, msg, fields) => {
        const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
        process.stderr.write(`[spawntree-daemon] [sandbox] ${level}: ${msg}${suffix}\n`);
      });
    this.ctx = { dataDir: this.dataDir, logger: this.logger };
  }

  /**
   * Activate configured providers and re-adopt any sandboxes that survived a
   * restart. Runs before `SessionManager.start()` in boot order, so it must
   * ensure the catalog schema itself — `applyCatalogSchema` is idempotent.
   */
  async start(): Promise<void> {
    await applyCatalogSchema(this.client);

    const config = loadSandboxConfig(join(this.dataDir, "sandboxes.json"));
    this.defaultProvider = config.defaultProvider;
    for (const entry of config.providers) {
      if (!entry.enabled) continue;
      const provider = this.registry.get(entry.id);
      if (!provider) {
        this.logger("warn", `unknown sandbox provider in config: "${entry.id}"`);
        continue;
      }
      this.active.set(entry.id, { provider, config: entry.config ?? {} });
    }

    await this.adoptFromCatalog();
  }

  /** Stop background watchers. Does NOT stop user containers — they outlive the daemon. */
  async stop(): Promise<void> {
    this.handles.clear();
  }

  /** Provider availability for the UI/API (docker on most hosts; apple on arm64 macOS). */
  async availableProviders(): Promise<Array<{ id: string; available: boolean }>> {
    const out: Array<{ id: string; available: boolean }> = [];
    for (const provider of this.registry.list()) {
      const available = await provider.isAvailable().catch(() => false);
      out.push({ id: provider.id, available });
    }
    return out;
  }

  /** The provider id used when a caller requests a sandbox without naming one. */
  resolveProviderId(requested?: string): string | undefined {
    if (requested) return requested;
    if (this.defaultProvider) return this.defaultProvider;
    return this.active.keys().next().value;
  }

  async createSandbox(providerId: string, spec: SandboxSpec): Promise<Sandbox> {
    const active = this.requireProvider(providerId);
    const id = `sbx_${randomUUID()}`;
    const handle = await active.provider.create(id, spec, active.config, this.ctx);
    this.handles.set(id, handle);
    await this.insertSandbox(handle.sandbox);
    return handle.sandbox;
  }

  async getSandbox(id: string): Promise<Sandbox | undefined> {
    const handle = this.handles.get(id);
    if (handle) {
      const live = await handle.status();
      if (handle.sandbox.managed) await this.updateStatus(id, live.status);
      return { ...handle.sandbox, status: live.status };
    }
    // Fall back to the live discovery list (covers external containers too).
    const all = await this.listSandboxes();
    return all.find((s) => s.id === id);
  }

  /**
   * Every container the host's providers can see — spawntree-created sandboxes
   * AND the user's existing containers (each `managed: false`) — merged with
   * catalog rows so a stopped spawntree sandbox still appears. Live runtime
   * status wins. Refreshes the discovery map so ops can adopt by id.
   */
  async listSandboxes(): Promise<Sandbox[]> {
    const byId = new Map<string, Sandbox>();
    // Catalog first: covers stopped spawntree sandboxes not in the runtime list.
    const rows = await this.catalog.select().from(sandboxes).orderBy(desc(sandboxes.updatedAt));
    for (const row of rows) byId.set(row.id, rowToSandbox(row));
    // Live runtime discovery: current status + external containers.
    for (const active of this.active.values()) {
      try {
        const live = await active.provider.list(active.config, this.ctx);
        for (const sb of live) {
          byId.set(sb.id, sb);
          this.discovered.set(sb.id, { providerId: sb.providerId, runtimeId: sb.runtimeId });
        }
      } catch (err) {
        this.logger("warn", `provider ${active.provider.id} list failed: ${errMessage(err)}`);
      }
    }
    return [...byId.values()];
  }

  async stopSandbox(id: string): Promise<void> {
    const handle = await this.resolveHandle(id);
    await handle.stop();
    if (handle.sandbox.managed) await this.updateStatus(id, "stopped");
  }

  async restartSandbox(id: string): Promise<void> {
    const handle = await this.resolveHandle(id);
    await handle.restart();
    if (handle.sandbox.managed) await this.updateStatus(id, "running");
  }

  async removeSandbox(id: string): Promise<void> {
    const handle = await this.resolveHandle(id).catch(() => null);
    if (handle) {
      await handle.remove();
      this.handles.delete(id);
    }
    this.discovered.delete(id);
    await this.catalog.delete(sandboxes).where(eq(sandboxes.id, id));
  }

  /** Follow a sandbox's combined logs. Returns an unsubscribe fn. */
  sandboxLogs(
    id: string,
    onLine: (stream: "stdout" | "stderr" | "system", line: string) => void,
  ): () => void {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void this.resolveHandle(id).then(
      (handle) => {
        if (cancelled) return;
        unsubscribe = handle.logs(onLine);
      },
      (err) => onLine("system", `cannot stream logs: ${errMessage(err)}`),
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

  /** A ProcessSpawner bound to a live sandbox — the bridge into the ACP layer. */
  async spawnerFor(id: string): Promise<ProcessSpawner> {
    return (await this.resolveHandle(id)).spawner();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private requireProvider(providerId: string): ActiveProvider {
    const active = this.active.get(providerId);
    if (!active) {
      throw new Error(`sandbox provider not enabled or unknown: "${providerId}"`);
    }
    return active;
  }

  /**
   * Resolve a live handle for `id`, adopting one on demand for containers this
   * daemon didn't create (so lifecycle ops work on external containers too).
   */
  private async resolveHandle(id: string): Promise<SandboxHandle> {
    const tracked = this.handles.get(id);
    if (tracked) return tracked;
    let meta = this.discovered.get(id);
    if (!meta) {
      await this.listSandboxes(); // refresh discovery
      meta = this.discovered.get(id);
    }
    if (!meta) throw new Error(`sandbox not found: ${id}`);
    const active = this.active.get(meta.providerId);
    if (!active) throw new Error(`sandbox provider not enabled: ${meta.providerId}`);
    const handle = await active.provider.adopt(meta.runtimeId, active.config, this.ctx);
    if (!handle) throw new Error(`sandbox not running: ${id}`);
    this.handles.set(id, handle);
    return handle;
  }

  private async adoptFromCatalog(): Promise<void> {
    const rows = await this.catalog.select().from(sandboxes);
    for (const row of rows) {
      const active = this.active.get(row.providerId);
      if (!active) continue;
      try {
        const handle = await active.provider.adopt(row.runtimeId, active.config, this.ctx);
        if (handle) {
          this.handles.set(row.id, handle);
        } else {
          // Container vanished while the daemon was down.
          await this.updateStatus(row.id, "exited");
        }
      } catch (err) {
        this.logger("warn", `failed to adopt sandbox ${row.id}: ${errMessage(err)}`);
      }
    }
  }

  private async insertSandbox(sandbox: Sandbox): Promise<void> {
    await this.catalog
      .insert(sandboxes)
      .values({
        id: sandbox.id,
        providerId: sandbox.providerId,
        runtimeId: sandbox.runtimeId,
        status: sandbox.status,
        image: sandbox.image,
        workspaceMode: sandbox.workspaceMode,
        repoId: sandbox.repoId,
        ephemeral: sandbox.ephemeral ? 1 : 0,
        mounts: [...sandbox.mounts],
        labels: sandbox.labels,
        createdAt: sandbox.createdAt,
        updatedAt: sandbox.updatedAt,
      })
      .onConflictDoUpdate({
        target: sandboxes.id,
        set: {
          runtimeId: sandbox.runtimeId,
          status: sandbox.status,
          image: sandbox.image,
          updatedAt: nowIso(),
        },
      });
  }

  private async updateStatus(id: string, status: SandboxStatus): Promise<void> {
    await this.catalog
      .update(sandboxes)
      .set({ status, updatedAt: nowIso() })
      .where(eq(sandboxes.id, id));
  }
}
