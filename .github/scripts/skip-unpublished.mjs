import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Resolve a package NAME to its package.json path under packages/*, or null.
export function packageFileFor(name, root = ".") {
  const dir = join(root, "packages");
  for (const d of readdirSync(dir)) {
    const f = join(dir, d, "package.json");
    if (!existsSync(f)) continue;
    if (JSON.parse(readFileSync(f, "utf8")).name === name) return f;
  }
  return null;
}

// Marks each package named in $NEW_PACKAGES (set by the workflow's "Check for
// unpublished packages" step) as private, so `changeset publish` skips it.
// npm automation tokens cannot create a brand-new package (it needs interactive
// 2FA), so a first-publish must be done once by a maintainer; after that the
// package is on npm and is no longer listed, making this a no-op. The edit is
// deliberately NOT committed — it only affects the current CI publish run.
export function main() {
  const names = (process.env.NEW_PACKAGES || "").split(/\s+/).filter(Boolean);
  if (names.length === 0) {
    console.log("skip-unpublished: no brand-new packages to skip");
    return;
  }
  for (const name of names) {
    const f = packageFileFor(name);
    if (!f) {
      console.log(`skip-unpublished: ${name} not found under packages/, ignoring`);
      continue;
    }
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.private = true;
    writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
    console.log(`skip-unpublished: marked ${name} private (${f}) so 'changeset publish' skips its first-publish`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
