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
