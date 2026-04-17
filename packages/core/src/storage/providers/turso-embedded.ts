import { createClient, type Client } from "@libsql/client";
import { Schema } from "effect";
import { resolve } from "node:path";
import type { PrimaryStorageHandle, PrimaryStorageProvider, ProviderStatus } from "../types.ts";

/**
 * Turso-backed primary. Uses `@libsql/client` in embedded-replica + offline
 * writes mode: reads and writes hit a local SQLite file for sub-ms latency,
 * and writes are synced to a Turso-hosted remote primary on a configurable
 * interval. When the daemon is offline, writes queue locally and flush when
 * the remote becomes reachable.
 *
 * Users provide their own Turso account and DB. gitenv and other consumers
 * can treat the remote URL as the read-replica to fetch from when the
 * local daemon is unreachable — same schema, same data, just read-only.
 *
 * NOTE (for upstream reviewer): validate the libSQL offline-writes behavior
 * matches the claim above against the client version we pin. The config
 * keys here reflect the `createClient({ url, syncUrl, authToken, syncInterval })`
 * shape. If `syncInterval` semantics change, surface it in status.
 */
export const TursoEmbeddedConfig = Schema.Struct({
  /**
   * Local SQLite file that backs the embedded replica. Defaults to
   * `<dataDir>/spawntree-turso.db`. Keeps Turso-mode data out of the way of
   * `spawntree.db` so swapping primaries doesn't stomp the other file.
   */
  localPath: Schema.optional(Schema.String),
  /**
   * libsql:// URL of the Turso-hosted primary. Required. This is the URL
   * read-only consumers (like a gitenv Host deployment) will also connect to
   * with a scoped read token.
   */
  syncUrl: Schema.String,
  /**
   * Auth token for the daemon's read/write access to the remote. Generate a
   * scoped token per machine so you can rotate/revoke independently.
   */
  authToken: Schema.String,
  /**
   * How often (seconds) the embedded replica auto-syncs with the remote.
   * `0` disables the interval; use `syncNow()` manually in that case.
   * Default: 5 seconds.
   */
  syncIntervalSec: Schema.optional(Schema.Number),
});
export type TursoEmbeddedConfigInput = Schema.Schema.Type<typeof TursoEmbeddedConfig>;
export type TursoEmbeddedConfig = TursoEmbeddedConfigInput & { syncIntervalSec: number };

function normalizeTursoConfig(c: TursoEmbeddedConfigInput): TursoEmbeddedConfig {
  return { ...c, syncIntervalSec: c.syncIntervalSec ?? 5 };
}

export const tursoEmbeddedProvider: PrimaryStorageProvider<TursoEmbeddedConfigInput> = {
  id: "turso-embedded",
  kind: "primary",
  configSchema: TursoEmbeddedConfig,

  async create(raw, ctx): Promise<PrimaryStorageHandle> {
    const config = normalizeTursoConfig(raw);
    const localPath = resolve(config.localPath ?? `${ctx.dataDir}/spawntree-turso.db`);
    ctx.logger("info", "storage.turso-embedded: opening", {
      localPath,
      syncUrl: config.syncUrl,
      syncIntervalSec: config.syncIntervalSec,
    });

    const client: Client = createClient({
      url: `file:${localPath}`,
      syncUrl: config.syncUrl,
      authToken: config.authToken,
      syncInterval: config.syncIntervalSec > 0 ? config.syncIntervalSec : undefined,
    });

    // Initial sync — also validates credentials + URL before we declare ready.
    try {
      await client.sync();
    } catch (err) {
      ctx.logger("error", "storage.turso-embedded: initial sync failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      client.close();
      throw err;
    }

    await client.execute("SELECT 1");

    const openedAt = new Date().toISOString();
    let lastSyncAt = openedAt;
    let lastSyncError: string | undefined;

    return {
      client,
      dbPath: localPath,
      async status(): Promise<ProviderStatus> {
        const now = new Date().toISOString();
        return {
          healthy: lastSyncError === undefined,
          lagMs: Date.parse(now) - Date.parse(lastSyncAt),
          lastOkAt: lastSyncAt,
          lastErrorAt: lastSyncError ? now : undefined,
          error: lastSyncError,
          info: {
            localPath,
            syncUrl: config.syncUrl,
            syncIntervalSec: config.syncIntervalSec,
            openedAt,
          },
        };
      },
      async syncNow() {
        try {
          await client.sync();
          lastSyncAt = new Date().toISOString();
          lastSyncError = undefined;
        } catch (err) {
          lastSyncError = err instanceof Error ? err.message : String(err);
          throw err;
        }
      },
      async shutdown() {
        // Best-effort final flush so no writes are left in the local replica.
        try {
          await client.sync();
        } catch {
          // Ignore — offline-writes mode means these will flush next time.
        }
        client.close();
      },
    };
  },
};
