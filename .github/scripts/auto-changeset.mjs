const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

export function maxBump(a, b) {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

const CONVENTIONAL = /^[*-]?\s*(\w+)(?:\([^)]*\))?(!)?:\s/;

export function extractBump(messages) {
  let bump = null;
  for (const msg of messages) {
    for (const rawLine of msg.split("\n")) {
      const line = rawLine.trim();
      if (/^BREAKING CHANGE:/.test(line)) { bump = maxBump(bump, "major"); continue; }
      const m = CONVENTIONAL.exec(line);
      if (!m) continue;
      const [, type, bang] = m;
      if (bang) { bump = maxBump(bump, "major"); continue; }
      if (type === "feat") bump = maxBump(bump, "minor");
      else if (["fix", "perf", "refactor", "revert"].includes(type)) bump = maxBump(bump, "patch");
    }
  }
  return bump;
}

export function computeRange(before, after, lastTag) {
  const head = after || "HEAD";
  const isZero = !before || /^0+$/.test(before);
  if (isZero) return lastTag ? `${lastTag}..${head}` : `${head}~1..${head}`;
  return `${before}..${head}`;
}

export function filesToPackages(files, packagesMeta) {
  const out = new Set();
  for (const f of files) {
    const m = /^packages\/([^/]+)\//.exec(f);
    if (!m) continue;
    const meta = packagesMeta.find((p) => p.dir === m[1]);
    if (meta) out.add(meta.name);
  }
  return [...out];
}

export function computeBumps({ commits, packagesMeta, isOnNpm }) {
  const publishable = new Map();
  for (const p of packagesMeta) {
    if (p.private || p.ignored) continue;
    publishable.set(p.name, p);
  }
  const perPkg = new Map();
  const touched = new Set();
  for (const c of commits) {
    const bump = extractBump([c.message]);
    for (const name of filesToPackages(c.files, packagesMeta)) {
      if (!publishable.has(name)) continue;
      touched.add(name);
      if (bump) perPkg.set(name, maxBump(perPkg.get(name), bump));
    }
  }
  for (const name of touched) if (!perPkg.has(name)) perPkg.set(name, "patch");

  const bumps = new Map();
  const skippedNew = [];
  for (const [name, level] of perPkg) {
    if (isOnNpm(name)) bumps.set(name, level);
    else skippedNew.push(name);
  }
  return { bumps, skippedNew };
}

export function renderChangeset(bumps, summary) {
  const fm = [...bumps].map(([name, level]) => `"${name}": ${level}`).join("\n");
  return `---\n${fm}\n---\n\n${summary}\n`;
}

export function parseGitLog(raw) {
  return raw
    .split("\x01")
    .filter((r) => r.length)
    .map((r) => {
      const hashEnd = r.indexOf("\x02");
      const bodyEnd = r.indexOf("\x03");
      const hash = r.slice(0, hashEnd);
      const message = r.slice(hashEnd + 1, bodyEnd);
      const files = r
        .slice(bodyEnd + 1)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return { hash, message, files };
    });
}

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function loadPackagesMeta(root) {
  const dir = join(root, "packages");
  const metas = [];
  for (const d of readdirSync(dir)) {
    const pj = join(dir, d, "package.json");
    if (!existsSync(pj)) continue;
    const json = JSON.parse(readFileSync(pj, "utf8"));
    if (!json.name) continue;
    metas.push({ dir: d, name: json.name, private: !!json.private });
  }
  return metas;
}

function loadIgnore(root) {
  const cfg = JSON.parse(readFileSync(join(root, ".changeset/config.json"), "utf8"));
  return new Set(cfg.ignore || []);
}

function makeIsOnNpm() {
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let exists = false;
    try {
      execFileSync("npm", ["view", name, "version"], { stdio: ["ignore", "ignore", "ignore"] });
      exists = true;
    } catch {
      exists = false;
    }
    cache.set(name, exists);
    return exists;
  };
}

function lastTagOrNull() {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function readCommits(range) {
  const raw = execFileSync(
    "git",
    ["log", range, "--format=\x01%H\x02%B\x03", "--name-only"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseGitLog(raw);
}

function appendLine(file, line) {
  if (file) writeFileSync(file, line.endsWith("\n") ? line : `${line}\n`, { flag: "a" });
}

export function main() {
  const root = process.cwd();
  const range = computeRange(process.env.BEFORE_SHA, process.env.AFTER_SHA, lastTagOrNull());
  const commits = readCommits(range);

  const ignore = loadIgnore(root);
  const packagesMeta = loadPackagesMeta(root).map((m) => ({ ...m, ignored: ignore.has(m.name) }));

  const { bumps, skippedNew } = computeBumps({ commits, packagesMeta, isOnNpm: makeIsOnNpm() });

  const ghOut = process.env.GITHUB_OUTPUT;
  const ghEnv = process.env.GITHUB_ENV;

  if (bumps.size === 0) {
    appendLine(ghOut, "has_changeset=false");
    console.log(`auto-changeset: nothing to release (range ${range})`);
  } else {
    const after = process.env.AFTER_SHA || "head";
    const summary =
      "Automated release from synced changes:\n" +
      commits.map((c) => `- ${c.message.split("\n")[0]}`).join("\n");
    const file = join(root, ".changeset", `auto-${after.slice(0, 12)}.md`);
    writeFileSync(file, renderChangeset(bumps, summary));
    appendLine(ghOut, "has_changeset=true");
    console.log(`auto-changeset: wrote ${file} -> ${[...bumps.keys()].join(", ")}`);
  }

  if (skippedNew.length) {
    appendLine(ghEnv, `NEW_PACKAGES=${skippedNew.join(" ")}`);
    console.log(`auto-changeset: skipped brand-new packages (need one-time first-publish): ${skippedNew.join(", ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
