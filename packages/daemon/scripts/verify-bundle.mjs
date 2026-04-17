#!/usr/bin/env node
/**
 * Build-time assertion: after `pnpm build` completes, the daemon's
 * self-contained dist MUST include the dashboard bundle. This catches
 * the regression where someone runs `pnpm --filter spawntree-daemon
 * build` without running the full build, or where the bundle-web step
 * silently skips (e.g. web wasn't built first) and we end up
 * publishing an npm tarball that serves "Web bundle not found" to
 * every user.
 *
 * Verifies:
 *   - dist/web/index.html exists
 *   - dist/web/assets has at least one .js and one .css
 *   - index.html references the built assets (not a stale stub)
 *
 * Exit 0 on success, 1 on any failure with a clear message.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const webDir = resolve(here, "../dist/web");
const indexPath = resolve(webDir, "index.html");
const assetsDir = resolve(webDir, "assets");

const failures = [];

if (!existsSync(indexPath)) {
  failures.push(
    `${indexPath} missing — run \`pnpm --filter spawntree-daemon run bundle-web\``,
  );
}

if (!existsSync(assetsDir)) {
  failures.push(`${assetsDir} missing — web build output incomplete`);
} else {
  const files = readdirSync(assetsDir);
  const hasJs = files.some((f) => f.endsWith(".js"));
  const hasCss = files.some((f) => f.endsWith(".css"));
  if (!hasJs) failures.push(`no .js files in ${assetsDir}`);
  if (!hasCss) failures.push(`no .css files in ${assetsDir}`);
}

if (failures.length === 0 && existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");
  if (!html.includes("/assets/")) {
    failures.push(
      `${indexPath} does not reference /assets/ — looks like a stale or fallback html`,
    );
  }
}

if (failures.length > 0) {
  console.error("[daemon] ✗ dashboard bundle check failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`[daemon] ✓ dashboard bundled at ${webDir}`);
