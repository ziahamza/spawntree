import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Schema } from "effect";
import { unlink } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
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
 *   2. PUT the snapshot to `s3://bucket/keyPrefix/spawntree.db.tmp-<ts>`.
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

/**
 * Encode a slash-separated S3 key for use in a `CopySource` URI.
 * `encodeURIComponent` on the full key mangles `/` separators into `%2F`,
 * which S3 rejects as an invalid source. Encode each segment separately.
 */
function encodeCopySourceKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * Classify an S3-side error for status reporting. We don't retry here
 * (the scheduler retries on the next tick), but we want to surface which
 * failures are worth alerting on vs. transient network blips.
 */
function classifyError(err: unknown): { message: string; fatal: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { name?: string; Code?: string }).name
    ?? (err as { Code?: string }).Code
    ?? "";
  const fatalCodes = new Set([
    "AccessDenied",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "NoSuchBucket",
    "InvalidBucketName",
    "PermanentRedirect",
  ]);
  return { message, fatal: fatalCodes.has(code) };
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
    let lastOkBytes: number | undefined;
    let lastEtag: string | undefined;
    let lastErrorAt: string | undefined;
    let lastError: string | undefined;
    let fatal = false;
    let inFlight: Promise<ProviderStatus> | null = null;
    let stopped = false;
    let paused = false;

    const runOnce = async (): Promise<ProviderStatus> => {
      if (inFlight) return inFlight;
      if (stopped) {
        return { healthy: false, error: "stopped" };
      }
      if (paused) {
        return {
          healthy: lastError === undefined,
          lastOkAt,
          lastErrorAt,
          error: "paused",
        };
      }

      const startedAt = Date.now();
      const ts = Date.now();
      const snapshotPath = resolve(ctx.dataDir, `.s3-snapshot-${ts}.db`);
      const tmpKey = keyFor(`spawntree.db.tmp-${ts}`);

      const runPromise = (async (): Promise<ProviderStatus> => {
        try {
          // Produce a consistent snapshot. VACUUM INTO is the canonical SQLite
          // way; libsql exposes raw exec so we use the same SQL.
          await primary.client.execute({
            sql: `VACUUM INTO ?`,
            args: [snapshotPath],
          });

          const size = statSync(snapshotPath).size;

          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: tmpKey,
              Body: createReadStream(snapshotPath),
              ContentLength: size,
              ContentType: "application/x-sqlite3",
            }),
          );

          const copyResult = await client.send(
            new CopyObjectCommand({
              Bucket: config.bucket,
              Key: finalKey,
              CopySource: `${config.bucket}/${encodeCopySourceKey(tmpKey)}`,
            }),
          );

          await client.send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: tmpKey,
            }),
          ).catch((err) => {
            // Non-fatal: leaving a tmp-key behind just means a dangling object.
            // Log but don't fail the run.
            ctx.logger("warn", "storage.s3-snapshot: tmp cleanup failed", {
              tmpKey,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          const etag = copyResult.CopyObjectResult?.ETag?.replace(/"/g, "");
          lastOkAt = new Date().toISOString();
          lastOkBytes = size;
          lastEtag = etag;
          lastError = undefined;
          lastErrorAt = undefined;
          fatal = false;
          ctx.logger("info", "storage.s3-snapshot: uploaded", {
            finalKey,
            bytes: size,
            etag,
            durationMs: Date.now() - startedAt,
          });

          return {
            healthy: true,
            lastOkAt,
            info: { finalKey, bytes: size, etag },
          };
        } catch (err) {
          const classified = classifyError(err);
          lastError = classified.message;
          lastErrorAt = new Date().toISOString();
          fatal = classified.fatal;
          ctx.logger("error", "storage.s3-snapshot: upload failed", {
            error: lastError,
            fatal,
          });
          // Best-effort tmp cleanup on error.
          await client.send(new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: tmpKey,
          })).catch(() => undefined);
          return {
            healthy: false,
            error: lastError,
            lastOkAt,
            lastErrorAt,
            info: { fatal },
          };
        } finally {
          await unlink(snapshotPath).catch(() => undefined);
        }
      })();

      inFlight = runPromise;
      try {
        return await runPromise;
      } finally {
        inFlight = null;
      }
    };

    // Background loop. Uses setTimeout (not setInterval) so we never overlap
    // runs; each tick waits for the previous to finish. Fatal errors stop the
    // loop so we don't hammer the backend with doomed requests — a manual
    // trigger can retry once the user fixes the config.
    let timer: NodeJS.Timeout | null = null;
    const scheduleNext = () => {
      if (stopped || paused || config.intervalSec <= 0 || fatal) return;
      timer = setTimeout(async () => {
        await runOnce().catch(() => undefined);
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
          info: {
            finalKey,
            intervalSec: config.intervalSec,
            inFlight: inFlight !== null,
            paused,
            fatal,
            lastOkBytes,
            lastEtag,
          },
        };
      },
      async trigger() {
        return runOnce();
      },
      async pause() {
        paused = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // Wait for any in-flight run to finish so the caller knows the
        // replicator is truly idle before it swaps the primary.
        if (inFlight) {
          await inFlight.catch(() => undefined);
        }
      },
      async resume() {
        paused = false;
        scheduleNext();
      },
      async stop() {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (inFlight) {
          await inFlight.catch(() => undefined);
        }
        client.destroy();
      },
    };
  },
};
