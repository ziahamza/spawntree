import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import type {
  PrimaryStorageHandle,
  ProviderStatus,
  ReplicatorHandle,
  ReplicatorProvider,
  StorageContext,
} from "../types.ts";

/**
 * Dumb-simple "upload the entire SQLite file to S3" replicator.
 *
 * Every `intervalSec` seconds (or when `trigger()` is called manually):
 *
 *   1. VACUUM INTO a temp file to produce a consistent byte-identical snapshot
 *      of the active primary. Uses the primary's libSQL client so it works
 *      for both plain local DBs and Turso-embedded replicas.
 *   2. Multipart-PUT the snapshot to `s3://bucket/keyPrefix/spawntree.db.tmp`.
 *   3. S3 CopyObject from the tmp key to `s3://bucket/keyPrefix/spawntree.db`
 *      (atomic from a reader's perspective — never a half-written read).
 *   4. DELETE the tmp key.
 *
 * Works with any S3-compatible backend: R2, Backblaze B2, MinIO, DigitalOcean
 * Spaces, plain AWS S3. Set `endpoint` + `region` accordingly.
 *
 * This is intentionally the dumb version. Litestream-style WAL streaming
 * and other continuous-replication providers can land as separate impls
 * against the same `ReplicatorProvider` interface.
 */
export const S3SnapshotConfig = Schema.Struct({
  /**
   * S3-compatible endpoint URL. Omit for AWS S3 default.
   * Examples:
   *   - Cloudflare R2: `https://<account>.r2.cloudflarestorage.com`
   *   - Backblaze B2: `https://s3.us-east-005.backblazeb2.com`
   *   - MinIO (local): `http://127.0.0.1:9000`
   */
  endpoint: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  bucket: Schema.String,
  /** Key prefix. Trailing slash optional. The final DB lands at `<prefix>/spawntree.db`. */
  keyPrefix: Schema.optional(Schema.String),
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  /** Force path-style addressing. Required for most non-AWS S3-compatible backends. */
  forcePathStyle: Schema.optional(Schema.Boolean),
  /** Upload every N seconds. `0` disables the interval; rely on `trigger()` instead. */
  intervalSec: Schema.optional(Schema.Number),
});
export type S3SnapshotConfigInput = Schema.Schema.Type<typeof S3SnapshotConfig>;
export type S3SnapshotConfig = S3SnapshotConfigInput & {
  region: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  intervalSec: number;
};

function normalizeS3Config(c: S3SnapshotConfigInput): S3SnapshotConfig {
  return {
    ...c,
    region: c.region ?? "auto",
    keyPrefix: c.keyPrefix ?? "",
    forcePathStyle: c.forcePathStyle ?? true,
    intervalSec: c.intervalSec ?? 60,
  };
}

export const s3SnapshotProvider: ReplicatorProvider<S3SnapshotConfigInput> = {
  id: "s3-snapshot",
  kind: "replicator",
  configSchema: S3SnapshotConfig,

  async start(
    raw,
    primary: PrimaryStorageHandle,
    ctx: StorageContext,
  ): Promise<ReplicatorHandle> {
    const config = normalizeS3Config(raw);
    if (!primary.dbPath) {
      throw new Error(
        `s3-snapshot requires a primary with a local dbPath; got a handle without one.`,
      );
    }

    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const prefix = config.keyPrefix.replace(/^\/+|\/+$/g, "");
    const keyFor = (name: string) => (prefix ? `${prefix}/${name}` : name);
    const finalKey = keyFor("spawntree.db");

    ctx.logger("info", "storage.s3-snapshot: starting", {
      bucket: config.bucket,
      finalKey,
      intervalSec: config.intervalSec,
    });

    let lastOkAt: string | undefined;
    let lastErrorAt: string | undefined;
    let lastError: string | undefined;
    let inFlight = false;
    let stopped = false;

    const runOnce = async (): Promise<ProviderStatus> => {
      if (inFlight) {
        return {
          healthy: lastError === undefined,
          lastOkAt,
          lastErrorAt,
          error: "snapshot_in_flight",
        };
      }
      inFlight = true;

      const startedAt = Date.now();
      const snapshotPath = `${ctx.dataDir}/.s3-snapshot-${Date.now()}.db`;
      const tmpKey = keyFor(`spawntree.db.tmp-${Date.now()}`);

      try {
        // Produce a consistent snapshot. VACUUM INTO is the canonical SQLite
        // way; libsql exposes raw exec so we use the same SQL.
        await primary.client.execute({
          sql: `VACUUM INTO ?`,
          args: [snapshotPath],
        });

        const body = createReadStream(snapshotPath);
        const size = statSync(snapshotPath).size;

        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: tmpKey,
            Body: body,
            ContentLength: size,
            ContentType: "application/x-sqlite3",
          }),
        );

        await client.send(
          new CopyObjectCommand({
            Bucket: config.bucket,
            Key: finalKey,
            CopySource: `${config.bucket}/${encodeURIComponent(tmpKey)}`,
          }),
        );

        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: tmpKey,
          }),
        );

        lastOkAt = new Date().toISOString();
        lastError = undefined;
        ctx.logger("info", "storage.s3-snapshot: uploaded", {
          finalKey,
          bytes: size,
          durationMs: Date.now() - startedAt,
        });

        return { healthy: true, lastOkAt, info: { finalKey, bytes: size } };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastErrorAt = new Date().toISOString();
        ctx.logger("error", "storage.s3-snapshot: upload failed", {
          error: lastError,
        });
        return { healthy: false, error: lastError, lastOkAt, lastErrorAt };
      } finally {
        inFlight = false;
        // Clean up local snapshot file.
        try {
          await readFile(snapshotPath).then(() => {
            // Intentionally empty — just to confirm exists; unlink below handles removal.
          });
        } catch {
          // ignore
        }
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(snapshotPath).catch(() => undefined);
        } catch {
          // ignore
        }
      }
    };

    // Background loop. Uses setTimeout (not setInterval) so we never overlap
    // runs; each tick waits for the previous to finish.
    let timer: NodeJS.Timeout | null = null;
    const scheduleNext = () => {
      if (stopped || config.intervalSec <= 0) return;
      timer = setTimeout(async () => {
        await runOnce();
        scheduleNext();
      }, config.intervalSec * 1000);
    };
    scheduleNext();

    return {
      async status() {
        return {
          healthy: lastError === undefined,
          lastOkAt,
          lastErrorAt,
          error: lastError,
          info: { finalKey, intervalSec: config.intervalSec, inFlight },
        };
      },
      async trigger() {
        return runOnce();
      },
      async stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        client.destroy();
      },
    };
  },
};
