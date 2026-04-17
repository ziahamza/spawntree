import { createClient, type Client } from "@libsql/client";
import { Schema } from "effect";
import { resolve } from "node:path";
import type { PrimaryStorageHandle, PrimaryStorageProvider, ProviderStatus, StorageContext } from "../types.ts";

/**
 * The default primary provider. Opens a plain local SQLite file via libSQL.
 * No network, no sync, no replication. This is what ships out of the box.
 *
 * `@libsql/client` is a superset of SQLite: passing `file:` URL gives you a
 * plain local SQLite database with no Turso behavior. This keeps the daemon
 * on a single DB client regardless of which primary the user picks.
 */
export const LocalStorageConfig = Schema.Struct({
  /**
   * Override the database file location. Defaults to `<dataDir>/spawntree.db`.
   * Useful for tests or for storing the DB on an external volume.
   */
  path: Schema.optional(Schema.String),
});
export type LocalStorageConfig = Schema.Schema.Type<typeof LocalStorageConfig>;

export const localStorageProvider: PrimaryStorageProvider<LocalStorageConfig> = {
  id: "local",
  kind: "primary",
  configSchema: LocalStorageConfig,

  async create(config, ctx): Promise<PrimaryStorageHandle> {
    const dbPath = resolve(config.path ?? `${ctx.dataDir}/spawntree.db`);
    ctx.logger("info", "storage.local: opening database", { dbPath });

    const client: Client = createClient({
      url: `file:${dbPath}`,
    });

    // Sanity ping so an invalid path fails fast.
    await client.execute("SELECT 1");

    const openedAt = new Date().toISOString();

    return {
      client,
      dbPath,
      async status(): Promise<ProviderStatus> {
        try {
          await client.execute("SELECT 1");
          return {
            healthy: true,
            lagMs: 0,
            lastOkAt: new Date().toISOString(),
            info: { dbPath, openedAt },
          };
        } catch (err) {
          return {
            healthy: false,
            error: err instanceof Error ? err.message : String(err),
            lastErrorAt: new Date().toISOString(),
          };
        }
      },
      async syncNow() {
        // Nothing to sync — local-only.
      },
      async shutdown() {
        client.close();
      },
    };
  },
};
