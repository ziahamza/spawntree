/**
 * Normalise a git remote URL into a stable `host/owner/repo` key.
 *
 * Handles:
 *   git@github.com:foo/bar.git           → github.com/foo/bar
 *   ssh://git@github.com/foo/bar.git     → github.com/foo/bar
 *   ssh://git@github.com:22/foo/bar      → github.com/foo/bar
 *   https://github.com/foo/bar.git       → github.com/foo/bar
 *   https://user:pw@github.com/foo/bar/  → github.com/foo/bar
 *   git://github.com/foo/bar             → github.com/foo/bar
 *   bare path like /repos/foo/bar.git    → null (no host)
 *
 * Output is lowercased.
 *
 * Spawntree-browser stores the normalised form alongside each clone in
 * the catalog. Consumers (gitenv-studio, future spawntree-web) layer
 * their own provider-specific matching on top of this — for example
 * gitenv pairs against `git_repos.full_name`. We intentionally do NOT
 * ship a `matchToRepo(repos)` helper here; that's a consumer concern.
 */
export function normalizeRemoteUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const url = input.trim();
  if (!url) return null;

  // SCP-like syntax: git@host:owner/repo(.git)
  const scp = url.match(/^([^@\s]+@)?([^:\s]+):([^\s]+)$/);
  if (scp && !url.includes("://")) {
    const host = scp[2];
    const path = scp[3];
    if (host && path && !path.startsWith("/")) {
      return cleanup(`${host}/${path}`);
    }
  }

  // URL-style: scheme://[user[:pw]@]host[:port]/path
  try {
    // Support git:// — the URL parser handles it fine.
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+/, "");
    if (!host || !path) return null;
    return cleanup(`${host}/${path}`);
  } catch {
    return null;
  }
}

function cleanup(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

/**
 * Extract the `owner/repo` segment from a normalised remote, or return
 * null if the input doesn't look like a host/owner/repo triple.
 *
 * Example: `github.com/foo/bar` → `foo/bar`. Useful as the join key for
 * consumers that have their own owner/repo identity (e.g. gitenv's
 * `git_repos.full_name`).
 */
export function ownerRepoFromNormalized(normalized: string | null): string | null {
  if (!normalized) return null;
  const segments = normalized.split("/");
  if (segments.length < 3) return null;
  return segments.slice(-2).join("/").toLowerCase();
}
