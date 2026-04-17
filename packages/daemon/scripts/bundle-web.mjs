#!/usr/bin/env node
/**
 * Copy `packages/web/dist` → `packages/daemon/dist/web` so the daemon
 * can ship the dashboard as part of its own `files: ["dist"]` tarball
 * when published to npm. Idempotent; clears the destination first.
 *
 * Runs as part of the root `pnpm build` AFTER `spawntree-web run build:only`.
 * If the web bundle doesn't exist, we skip with a warning rather than
 * failing — useful for CI contexts that intentionally build only parts
 * of the monorepo.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = resolve(here, "../../web/dist");
const dst = resolve(here, "../dist/web");

if (!existsSync(src)) {
  console.warn(
    `[daemon] skip bundle-web — ${src} does not exist (run \`pnpm --filter spawntree-web build\` first)`,
  );
  process.exit(0);
}

rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log(`[daemon] bundled web → ${dst}`);
