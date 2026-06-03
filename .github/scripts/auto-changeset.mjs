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
