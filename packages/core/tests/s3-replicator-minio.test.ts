import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  localStorageProvider,
  s3SnapshotProvider,
  type PrimaryStorageHandle,
  type StorageContext,
} from "../src/storage/index.ts";

/**
 * Integration test against a running MinIO instance.
 *
 * Gated on `SPAWNTREE_S3_TEST_ENDPOINT` so it doesn't break CI (which doesn't
 * run MinIO). To exercise locally:
 *
 *   docker run -d --rm --name mio -p 9100:9000 \
 *     -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret \
 *     minio/minio server /data
 *   docker run --rm --network host --entrypoint sh minio/mc -c \
 *     "mc alias set local http://127.0.0.1:9100 testkey testsecret && \
 *      mc mb --ignore-existing local/spawntree-test"
 *   SPAWNTREE_S3_TEST_ENDPOINT=http://127.0.0.1:9100 \
 *   SPAWNTREE_S3_TEST_BUCKET=spawntree-test \
 *   SPAWNTREE_S3_TEST_ACCESS_KEY=testkey \
 *   SPAWNTREE_S3_TEST_SECRET_KEY=testsecret \
 *     pnpm --filter spawntree-core test
 *
 * These tests are the ground truth that the S3 snapshot path actually works
 * end-to-end against a real S3-compatible backend — including the CopyObject
 * atomic-swap semantics that Devin flagged as buggy on keyPrefix values with
 * slashes.
 */

const endpoint = process.env["SPAWNTREE_S3_TEST_ENDPOINT"];
const bucket = process.env["SPAWNTREE_S3_TEST_BUCKET"];
const accessKeyId = process.env["SPAWNTREE_S3_TEST_ACCESS_KEY"];
const secretAccessKey = process.env["SPAWNTREE_S3_TEST_SECRET_KEY"];

const SHOULD_RUN = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

describe.skipIf(!SHOULD_RUN)("s3SnapshotProvider against MinIO", () => {
  let tmp: string;
  let ctx: StorageContext;
  let s3: S3Client;
  let keyPrefix: string;
  let primary: PrimaryStorageHandle;

  beforeEach(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "spawntree-s3-test-"));
    ctx = { dataDir: tmp, logger: () => undefined };
    keyPrefix = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    s3 = new S3Client({
      endpoint: endpoint!,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
    primary = await localStorageProvider.create({}, ctx);
    await primary.client.execute(`CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT)`);
    await primary.client.execute(`INSERT INTO sessions VALUES ('s1', 'hello'), ('s2', 'world')`);
  });

  afterEach(async () => {
    await primary.shutdown().catch(() => undefined);
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket!, Prefix: keyPrefix }));
      if (list.Contents?.length) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket!,
            Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) },
          }),
        );
      }
    } catch {
      // ignore
    }
    s3.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uploads canonical key with slash-containing prefix (regression: CopySource encoding)", async () => {
    const handle = await s3SnapshotProvider.start(
      {
        endpoint,
        region: "us-east-1",
        bucket: bucket!,
        // Slash-containing prefix is exactly the Devin regression case.
        keyPrefix: `${keyPrefix}/laptop`,
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        forcePathStyle: true,
        intervalSec: 0,
      },
      primary,
      ctx,
    );
    try {
      const status = await handle.trigger();
      expect(status.healthy).toBe(true);
      expect(status.error).toBeUndefined();

      const finalKey = `${keyPrefix}/laptop/spawntree.db`;
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket!, Key: finalKey }));
      expect(obj.ContentLength).toBeGreaterThan(0);

      // Tmp keys must be cleaned up.
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket!,
          Prefix: `${keyPrefix}/laptop/`,
        }),
      );
      const keys = (list.Contents ?? []).map((o) => o.Key ?? "");
      expect(keys).toContain(finalKey);
      for (const k of keys) {
        expect(k).not.toMatch(/\.tmp-/);
      }
    } finally {
      await handle.stop();
    }
  });

  it("populates lastOkBytes + etag in status info", async () => {
    const handle = await s3SnapshotProvider.start(
      {
        endpoint,
        region: "us-east-1",
        bucket: bucket!,
        keyPrefix: `${keyPrefix}/status`,
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        forcePathStyle: true,
        intervalSec: 0,
      },
      primary,
      ctx,
    );
    try {
      await handle.trigger();
      const status = await handle.status();
      const info = status.info as Record<string, unknown>;
      expect(info["lastOkBytes"]).toBeGreaterThan(0);
      expect(info["lastEtag"]).toMatch(/[a-f0-9]+/i);
      expect(info["fatal"]).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("classifies bad credentials as fatal", async () => {
    const handle = await s3SnapshotProvider.start(
      {
        endpoint,
        region: "us-east-1",
        bucket: bucket!,
        keyPrefix: `${keyPrefix}/bad`,
        accessKeyId: "wrong-key",
        secretAccessKey: "wrong-secret",
        forcePathStyle: true,
        intervalSec: 0,
      },
      primary,
      ctx,
    );
    try {
      const status = await handle.trigger();
      expect(status.healthy).toBe(false);
      expect(status.error).toBeTruthy();
      const info = status.info as Record<string, unknown>;
      expect(info["fatal"]).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("pause() drains in-flight and halts the background loop", async () => {
    // Short interval so a tick fires while we're waiting.
    const handle = await s3SnapshotProvider.start(
      {
        endpoint,
        region: "us-east-1",
        bucket: bucket!,
        keyPrefix: `${keyPrefix}/pause`,
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        forcePathStyle: true,
        intervalSec: 1,
      },
      primary,
      ctx,
    );
    try {
      // Kick a manual trigger, then pause while it runs.
      const t = handle.trigger();
      expect(typeof handle.pause).toBe("function");
      await handle.pause?.();
      await t;

      const status = await handle.status();
      const info = status.info as Record<string, unknown>;
      expect(info["paused"]).toBe(true);
      expect(info["inFlight"]).toBe(false);

      // Triggering while paused should return an explicit "paused" status.
      const triggered = await handle.trigger();
      expect(triggered.error).toBe("paused");
    } finally {
      await handle.stop();
    }
  });
});
