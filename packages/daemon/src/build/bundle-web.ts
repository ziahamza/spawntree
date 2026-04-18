/**
 * Build-time step: copy `packages/web/dist` into `packages/daemon/dist/web`
 * so the daemon's `files: ["dist"]` tarball ships the dashboard together
 * with the server. Without this the published daemon serves the
 * "Web bundle not found" fallback to every user.
 *
 * Compiled by the daemon's tsc (lives under `src/build/`) and run after
 * tsc produces `dist/build/bundle-web.js`. Runs as part of the root
 * `pnpm build` after `spawntree-web run build:only`.
 *
 * Not a test. Not a runtime module. Pure build infrastructure.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function main(): number {
  // `import.meta.url` inside the compiled output is
  // `.../packages/daemon/dist/build/bundle-web.js`.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = resolve(here, "../../../web/dist");
  const dst = resolve(here, "../web");

  if (!existsSync(src)) {
    console.warn(
      `[daemon] skip bundle-web — ${src} does not exist (run \`pnpm --filter spawntree-web build\` first)`,
    );
    return 0;
  }

  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[daemon] bundled web → ${dst}`);
  return 0;
}

process.exit(main());
