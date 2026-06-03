const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

export function maxBump(a, b) {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}
