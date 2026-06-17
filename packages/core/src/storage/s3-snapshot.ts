import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { unlink } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  S3SnapshotConfig,
  S3SnapshotConfigInput,
  SnapshotSyncHandle,
  SqliteStorageHandle,
  StorageHealth,
  StorageContext,
} from "./types.ts";

/**
 * Upload the entire local SQLite catalog file to S3 on a timer.
 *
 * Every `intervalSec` seconds (or when `trigger()` is called manually):
 *
 *   1. VACUUM INTO a temp file to produce a consistent byte-identical snapshot
 *      of the active SQLite catalog.
 *   2. PUT the snapshot to `s3://bucket/keyPrefix/spawntree.db.tmp-<ts>`.
 *   3. S3 CopyObject from the tmp key to `s3://bucket/keyPrefix/spawntree.db`
 *      (atomic from a reader's perspective — never a half-written read).
 *   4. DELETE the tmp key.
 *
 * Works with any S3-compatible backend: R2, Backblaze B2, MinIO, DigitalOcean
 * Spaces, plain AWS S3. Set `endpoint` + `region` accordingly.
 *
 * This is intentionally the dumb version. Litestream-style WAL streaming can
 * replace this implementation later without changing the catalog source.
 */

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
  const code =
    (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code ?? "";
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

export async function startS3SnapshotSync(
  raw: S3SnapshotConfigInput,
  storage: SqliteStorageHandle,
  ctx: StorageContext,
): Promise<SnapshotSyncHandle> {
  const config = normalizeS3Config(raw);

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

  ctx.logger("info", "storage.s3: starting snapshot loop", {
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
  let inFlight: Promise<StorageHealth> | null = null;
  let stopped = false;

  const runOnce = async (): Promise<StorageHealth> => {
    if (inFlight) return inFlight;
    if (stopped) {
      return { healthy: false, error: "stopped" };
    }

    const startedAt = Date.now();
    const ts = Date.now();
    const snapshotPath = resolve(ctx.dataDir, `.s3-snapshot-${ts}.db`);
    const tmpKey = keyFor(`spawntree.db.tmp-${ts}`);

    const runPromise = (async (): Promise<StorageHealth> => {
      try {
        // Produce a consistent snapshot. VACUUM INTO is the canonical SQLite
        // way; libsql exposes raw exec so we use the same SQL.
        await storage.client.execute({
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

        await client
          .send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: tmpKey,
            }),
          )
          .catch((err) => {
            // Non-fatal: leaving a tmp-key behind just means a dangling object.
            // Log but don't fail the run.
            ctx.logger("warn", "storage.s3: tmp cleanup failed", {
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
        ctx.logger("info", "storage.s3: uploaded snapshot", {
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
        ctx.logger("error", "storage.s3: snapshot upload failed", {
          error: lastError,
          fatal,
        });
        // Best-effort tmp cleanup on error.
        await client
          .send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: tmpKey,
            }),
          )
          .catch(() => undefined);
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
  // loop so we don't hammer the backend with doomed requests. A manual trigger
  // can retry once the user fixes the config.
  let timer: NodeJS.Timeout | null = null;
  const scheduleNext = () => {
    if (stopped || config.intervalSec <= 0 || fatal) return;
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
          fatal,
          lastOkBytes,
          lastEtag,
        },
      };
    },
    async trigger() {
      return runOnce();
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
}
