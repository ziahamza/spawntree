import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * Build-output assertions: after `pnpm build`, the daemon's
 * self-contained `dist/web/` MUST hold a real dashboard bundle.
 *
 * Catches the regression where someone runs `pnpm --filter
 * spawntree-daemon build` without the full build chain, or where the
 * bundle-web step silently skipped (e.g. web wasn't built first) and
 * we end up publishing a tarball that serves "Web bundle not found"
 * to every user.
 *
 * Depends on `pnpm build` having run. CI runs it as part of the
 * standard `pnpm test` step which gates every PR. In dev, run
 * `pnpm build && pnpm test` to exercise the full chain.
 */

const daemonRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webDir = resolve(daemonRoot, "dist/web");
const indexPath = resolve(webDir, "index.html");
const assetsDir = resolve(webDir, "assets");

describe("dashboard bundle", () => {
  it("dist/web/index.html exists (run `pnpm build` first if this fails)", () => {
    expect(existsSync(indexPath), `missing: ${indexPath}`).toBe(true);
  });

  it("dist/web/assets contains at least one .js file", () => {
    expect(existsSync(assetsDir), `missing: ${assetsDir}`).toBe(true);
    const files = readdirSync(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));
    expect(jsFiles.length, "no .js bundle in assets/").toBeGreaterThan(0);
  });

  it("dist/web/assets contains at least one .css file", () => {
    expect(existsSync(assetsDir), `missing: ${assetsDir}`).toBe(true);
    const files = readdirSync(assetsDir);
    const cssFiles = files.filter((f) => f.endsWith(".css"));
    expect(cssFiles.length, "no .css bundle in assets/").toBeGreaterThan(0);
  });

  it("index.html references /assets/ — not a stale fallback", () => {
    const html = readFileSync(indexPath, "utf8");
    expect(
      html.includes("/assets/"),
      "index.html has no /assets/ references — looks like a stale or fallback html",
    ).toBe(true);
  });

  it("index.html is not the 'Web bundle not found' fallback text", () => {
    const html = readFileSync(indexPath, "utf8");
    expect(
      html.includes("Web bundle not found"),
      "index.html contains the fallback text instead of the real dashboard",
    ).toBe(false);
  });
});
