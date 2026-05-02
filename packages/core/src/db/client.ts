import { createClient, type Client, type Config as LibSqlConfig } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { BASELINE_DDL, schema, type Schema } from "./schema.ts";

/**
 * Drizzle database typed with the spawntree catalog schema. Hands you the
 * full relational query API:
 *
 *   await db.query.repos.findMany({ where: eq(repos.provider, 'github') })
 *   await db.select().from(repos).leftJoin(clones, eq(clones.repoId, repos.id))
 */
export type CatalogDb = LibSQLDatabase<Schema>;

/**
 * Handle returned by `createCatalogClient`. Exposes the typed Drizzle `db`,
 * the raw libSQL `client` (for `execute` / `batch` / `VACUUM INTO` /
 * `sync()` escape hatches), the `schema` object for query construction,
 * and a `close()` to release the connection.
 */
export interface CatalogClient {
  readonly db: CatalogDb;
  readonly client: Client;
  readonly schema: Schema;
  close(): void;
}

export interface CreateCatalogClientOptions {
  /**
   * libSQL connection URL. Accepts everything `@libsql/client` does:
   *   - `file:/absolute/path.db` for a local SQLite file
   *   - `libsql://<db>.turso.io` for a remote Turso replica
   *   - `http://...` / `ws://...` for alternate transports
   */
  url: string;
  /** Auth token for remote libSQL servers (Turso). */
  authToken?: string;
  /** Reuse an existing libSQL client instead of creating one. */
  client?: Client;
  /**
   * If true, run the baseline DDL (`CREATE TABLE IF NOT EXISTS`) before
   * returning the client. Safe on a fully-populated database — the schema
   * already exists and statements are no-ops.
   *
   * Default: `false`. The daemon owns DDL; external readers should NOT
   * bootstrap — if the tables don't exist, something is wrong upstream
   * and you want to know, not paper over it.
   */
  bootstrap?: boolean;
  /** Advanced: forward any additional libSQL client config. */
  libsql?: Partial<LibSqlConfig>;
}

/**
 * Build a typed catalog client against any libSQL-compatible database.
 *
 * Designed for external consumers that want read access to a spawntree
 * catalog without standing up the daemon or reimplementing HTTP endpoints:
 *
 * ```ts
 * import { createCatalogClient, schema } from "spawntree-core";
 * import { eq } from "drizzle-orm";
 *
 * const catalog = createCatalogClient({ url: "file:/Users/me/.spawntree/spawntree.db" });
 * try {
 *   const githubRepos = await catalog.db
 *     .select()
 *     .from(schema.repos)
 *     .where(eq(schema.repos.provider, "github"));
 *   console.log(githubRepos);
 * } finally {
 *   catalog.close();
 * }
 * ```
 *
 * Also works against a Turso replica that spawntree's `turso-embedded`
 * primary is syncing to — pass `url: "libsql://..."` + `authToken`. The
 * schema is shared, so the rows are typed identically.
 */
export function createCatalogClient(options: CreateCatalogClientOptions): CatalogClient {
  const client =
    options.client ??
    createClient({
      url: options.url,
      authToken: options.authToken,
      ...options.libsql,
    });
  if (options.bootstrap) {
    // Synchronous-looking caller contract for the sync variant; if callers
    // want to await bootstrap they should use `createCatalogClientAsync`.
    throw new Error("bootstrap: true requires createCatalogClientAsync — DDL is async");
  }
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    schema,
    close() {
      client.close();
    },
  };
}

/**
 * Async variant that can run the baseline DDL before returning. Intended
 * for the daemon's own `CatalogDatabase`; external read-only consumers
 * should use `createCatalogClient` and let the daemon own the schema.
 */
export async function createCatalogClientAsync(
  options: CreateCatalogClientOptions,
): Promise<CatalogClient> {
  const client =
    options.client ??
    createClient({
      url: options.url,
      authToken: options.authToken,
      ...options.libsql,
    });
  if (options.bootstrap !== false) {
    for (const stmt of BASELINE_DDL) {
      await client.execute(stmt);
    }
  }
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    schema,
    close() {
      client.close();
    },
  };
}
