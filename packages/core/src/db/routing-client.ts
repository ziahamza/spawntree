import {
  catalogHttpProxy,
  type CatalogHttpDb,
  type CatalogHttpProxy,
  type CreateCatalogHttpDbOptions,
} from "./http-client.ts";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { schema } from "./schema.ts";
import { probeDaemonReachable } from "./probe.ts";

/**
 * The "daemon-first, host-fallback" pattern in one factory.
 *
 * Embedders (gitenv, custom dashboards, internal tools) typically want
 * the same shape: prefer the local daemon when it's reachable (fast,
 * private, exposes mutations), fall back to a federation host or remote
 * mirror when it isn't. They were each rebuilding it in a slightly
 * different way; lifting it into core eliminates the duplication and
 * gives one place to evolve the policy (caching, exponential backoff,
 * retry on per-query failure, etc.).
 *
 * What this returns is a Drizzle database whose proxy callback decides
 * per-query which endpoint to hit, based on a TTL-cached probe of the
 * primary URL. Once primary fails the probe, queries flow to the
 * fallback for `probeTtlMs` before the next probe is attempted. The
 * cache means we don't probe on every query — only when the previous
 * probe is stale or after the primary recovers.
 *
 * ```ts
 * import { createRoutingCatalogClient, schema } from "spawntree-core/browser";
 *
 * const db = createRoutingCatalogClient({
 *   primary:  { url: "http://127.0.0.1:2222" },
 *   fallback: { url: "https://spawntree-host.internal", authToken: "dh_…" },
 * });
 *
 * // Use it like any Drizzle database. The routing is invisible.
 * const rows = await db.select().from(schema.sessions).limit(20);
 * ```
 */
export interface CreateRoutingCatalogClientOptions {
  /** Preferred endpoint — typically the local daemon. */
  primary: CreateCatalogHttpDbOptions;
  /** Used when `primary` is unreachable. Typically a federation host. */
  fallback: CreateCatalogHttpDbOptions;
  /**
   * How long a probe result is cached, in ms. Default 30s.
   * Tradeoff: shorter values recover from primary outages faster but
   * cost an extra round-trip on each window boundary.
   */
  probeTtlMs?: number;
  /**
   * Per-probe timeout. Default 800ms. The same value used by
   * `probeDaemonReachable`. Don't make this too aggressive — under load
   * a healthy localhost daemon can take a couple hundred ms to reply.
   */
  probeTimeoutMs?: number;
  /**
   * Override the probe function — useful for tests, or to swap in a
   * domain-specific liveness check (auth probe, version probe, etc.).
   */
  probe?: (url: string) => Promise<boolean>;
  /**
   * Hook fired when the active endpoint changes. Embedders use this to
   * surface "Live (local daemon)" / "Read-only (host mirror)" badges.
   */
  onRouteChange?: (active: "primary" | "fallback") => void;
}

/**
 * Same return type as `createCatalogHttpDb` — just with two endpoints
 * stitched behind it.
 */
export type RoutingCatalogClient = CatalogHttpDb;

/**
 * Build a Drizzle database that automatically routes between a primary
 * (local daemon) and a fallback (federation host or remote mirror)
 * based on a cached liveness probe.
 */
export function createRoutingCatalogClient(
  options: CreateRoutingCatalogClientOptions,
): RoutingCatalogClient {
  const proxy = createRoutingCatalogProxy(options);
  return drizzle(proxy, { schema });
}

/**
 * Like `createRoutingCatalogClient` but returns the raw proxy callback,
 * so callers can wire it into Drizzle themselves with their own schema
 * or middleware.
 */
export function createRoutingCatalogProxy(
  options: CreateRoutingCatalogClientOptions,
): CatalogHttpProxy {
  const probeTtlMs = options.probeTtlMs ?? 30_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 800;
  const probe =
    options.probe ??
    ((url: string) =>
      probeDaemonReachable({
        url,
        timeoutMs: probeTimeoutMs,
        fetch: options.primary.fetch,
      }));

  const primaryProxy = catalogHttpProxy(options.primary);
  const fallbackProxy = catalogHttpProxy(options.fallback);

  // Cache shape: `{ ok, expiresAt }`. `null` means we haven't probed yet
  // (so the first query forces a probe). After that, a stale entry
  // triggers a re-probe; a fresh entry is honored without network.
  let cache: { ok: boolean; expiresAt: number } | null = null;
  // Inflight dedupe: avoid stampedes when many queries arrive at once
  // and the cache has just expired.
  let inflightProbe: Promise<boolean> | null = null;
  let lastActive: "primary" | "fallback" | null = null;

  const decide = async (): Promise<"primary" | "fallback"> => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return cache.ok ? "primary" : "fallback";
    }
    if (!inflightProbe) {
      inflightProbe = probe(options.primary.url)
        .catch(() => false)
        .then((ok) => {
          cache = { ok, expiresAt: Date.now() + probeTtlMs };
          inflightProbe = null;
          return ok;
        });
    }
    const ok = await inflightProbe;
    return ok ? "primary" : "fallback";
  };

  return async (sql, params, method) => {
    const active = await decide();
    if (active !== lastActive) {
      lastActive = active;
      options.onRouteChange?.(active);
    }
    const proxyToUse = active === "primary" ? primaryProxy : fallbackProxy;
    return proxyToUse(sql, params, method);
  };
}
