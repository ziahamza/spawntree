/**
 * Lightweight daemon-availability probe used by the catalog routing
 * client. Surfaced as its own export because the same primitive is
 * useful anywhere a consumer wants to fall back when the local daemon
 * isn't reachable: status badges, CLI commands, dashboards, etc.
 *
 * The check is deliberately simple — a `GET /health` with a short
 * timeout. It does NOT try to enumerate features or version-match.
 * If `/health` returns 2xx within the budget, the daemon is in.
 */

export interface ProbeDaemonOptions {
  /** Base URL of the daemon, e.g. `http://127.0.0.1:2222`. */
  url: string;
  /**
   * Per-attempt timeout. The probe gives up at this point, so the
   * caller's UI doesn't stall waiting for an unreachable host. Default
   * 800ms — short enough that a slow probe doesn't feel like a hang,
   * long enough that a healthy localhost daemon answers comfortably.
   */
  timeoutMs?: number;
  /** Override `fetch`. Same hook as the rest of the catalog helpers. */
  fetch?: typeof fetch;
  /** Path to probe. Defaults to `/health` (the daemon's standard liveness route). */
  path?: string;
}

/**
 * Probe a spawntree daemon for liveness. Resolves to `true` if the
 * `/health` route responded with 2xx within the timeout, `false` for
 * anything else (network error, non-2xx, timeout). Never rejects — the
 * routing client treats this as a boolean signal, so an unreachable
 * daemon must look the same as a daemon that returned 500.
 */
export async function probeDaemonReachable(options: ProbeDaemonOptions): Promise<boolean> {
  const base = options.url.replace(/\/+$/, "");
  const path = (options.path ?? "/health").replace(/^(?!\/)/, "/");
  const timeoutMs = options.timeoutMs ?? 800;
  const doFetch: typeof fetch = options.fetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}${path}`, {
      method: "GET",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Network error, abort, or any other failure — treat as unreachable.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
