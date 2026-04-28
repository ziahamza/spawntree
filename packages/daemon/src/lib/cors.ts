/**
 * CORS / Private Network Access for daemon HTTP routes.
 *
 * The daemon listens on `127.0.0.1` and is reached from two kinds of
 * browser origins:
 *
 *   1. **Loopback** — Studio served from `http://localhost:*` (dev) or a
 *      desktop bundle on `app://`. Same-network, browsers don't need PNA.
 *
 *   2. **Public HTTPS** — Studio served from `https://gitenv.dev` (the
 *      common case in production). The browser treats public→loopback as
 *      a security boundary and requires the daemon to opt in via the
 *      Private Network Access (PNA) protocol:
 *      https://wicg.github.io/private-network-access/
 *
 * For PNA-gated requests, Chrome/Edge include `Access-Control-Request-
 * Private-Network: true` on the preflight. The daemon MUST respond with
 * `Access-Control-Allow-Private-Network: true` (along with the usual CORS
 * allow headers) or the actual fetch never runs.
 *
 * The default allow-list covers loopback and the gitenv production
 * origins. Operators can extend it via env vars or by setting
 * `SPAWNTREE_CATALOG_TRUST_REMOTE=1` to allow any origin (handy for self-
 * hosted Studio deployments and integration tests).
 */

const DEFAULT_PUBLIC_ORIGINS = [
  "https://gitenv.dev",
  "https://www.gitenv.dev",
  "https://studio.gitenv.dev",
  "https://app.gitenv.dev",
] as const;

/** Hostnames considered loopback. Any port. Any scheme. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface CorsPolicy {
  /** When true, every origin is allowed. Used by `SPAWNTREE_*_TRUST_REMOTE=1`. */
  trustRemote: boolean;
  /**
   * Additional explicit origins to allow on top of loopback + the
   * default public list. Read from `SPAWNTREE_CORS_ORIGINS` (comma-separated).
   */
  extraOrigins?: ReadonlyArray<string>;
}

/**
 * Returns true if the given Origin header value is permitted to make
 * cross-origin requests to the daemon.
 */
export function isAllowedBrowserOrigin(origin: string, policy: CorsPolicy): boolean {
  if (policy.trustRemote) return true;
  if (!origin) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return true;

  const normalized = `${url.protocol}//${url.host}`;
  if (DEFAULT_PUBLIC_ORIGINS.includes(normalized as (typeof DEFAULT_PUBLIC_ORIGINS)[number])) {
    return true;
  }
  if (policy.extraOrigins && policy.extraOrigins.includes(normalized)) {
    return true;
  }
  return false;
}

/**
 * Build the CORS response headers for a preflight or successful request.
 *
 * Pass `pnaRequested=true` when the preflight included
 * `Access-Control-Request-Private-Network: true`. We always echo allow
 * back so the browser permits the actual fetch.
 */
export interface CorsHeaderOptions {
  /** Whether the preflight requested PNA (echo allow back). */
  pnaRequested?: boolean;
  /** Allowed methods for this route group. Defaults to read+write. */
  methods?: string;
}

const DEFAULT_METHODS = "GET,POST,DELETE,OPTIONS";

export function buildCorsHeaders(origin: string, options: CorsHeaderOptions = {}): Headers {
  const h = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": options.methods ?? DEFAULT_METHODS,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Private-Network",
  });
  if (options.pnaRequested) {
    h.set("Access-Control-Allow-Private-Network", "true");
  }
  return h;
}

/**
 * Same as `buildCorsHeaders` but as iterable entries for `c.header(name, value)`
 * style API surfaces.
 */
export function corsHeaderEntries(
  origin: string,
  options: CorsHeaderOptions = {},
): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["Access-Control-Allow-Origin", origin],
    ["Access-Control-Allow-Methods", options.methods ?? DEFAULT_METHODS],
    ["Access-Control-Allow-Headers", "Content-Type, Authorization"],
    ["Access-Control-Max-Age", "86400"],
    ["Vary", "Origin, Access-Control-Request-Private-Network"],
  ];
  if (options.pnaRequested) {
    entries.push(["Access-Control-Allow-Private-Network", "true"]);
  }
  return entries;
}

/**
 * Resolve a `CorsPolicy` from environment variables. Both
 * `SPAWNTREE_CATALOG_TRUST_REMOTE` and `SPAWNTREE_SESSIONS_TRUST_REMOTE`
 * default the same way and historically existed independently; either
 * flag opens up the policy for that route group.
 */
export function corsPolicyFromEnv(envFlag: string): CorsPolicy {
  const trustRemote = process.env[envFlag] === "1";
  const extra = process.env["SPAWNTREE_CORS_ORIGINS"];
  const extraOrigins = extra
    ? extra.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  return { trustRemote, extraOrigins };
}
