import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { setApiBaseUrl } from "./api";

/**
 * Host-switcher state management.
 *
 * The dashboard can talk to either:
 *   1. The same-origin local daemon (the default — it's what's serving
 *      this bundle). `activeHost === null`.
 *   2. A remote spawntree daemon, proxied through a federation host
 *      server (see `spawntree-host` package). `activeHost === <name>`,
 *      API calls go to `<registryUrl>/h/<name>/...`.
 *
 * Users point at a `spawntree-host` registry by entering its URL in the
 * host-switcher dropdown. It's persisted to localStorage so the
 * selection survives reloads. Nothing leaks to the network unless the
 * user opts in — localhost-only by default.
 */

const REGISTRY_KEY = "spawntree:hostRegistryUrl";
const ACTIVE_KEY = "spawntree:activeHost";

export interface RegisteredHost {
  name: string;
  url: string;
  label: string | null;
  registeredAt: string;
  lastSeenAt: string | null;
}

interface HostsState {
  registryUrl: string;
  activeHost: string | null;
}

function readLocalStorage(): HostsState {
  if (typeof window === "undefined") {
    return { registryUrl: "", activeHost: null };
  }
  try {
    return {
      registryUrl: window.localStorage.getItem(REGISTRY_KEY) ?? "",
      activeHost: window.localStorage.getItem(ACTIVE_KEY),
    };
  } catch {
    return { registryUrl: "", activeHost: null };
  }
}

function applyBaseUrl(state: HostsState): void {
  if (!state.registryUrl || !state.activeHost) {
    setApiBaseUrl(undefined); // same-origin local daemon
    return;
  }
  const trimmed = state.registryUrl.replace(/\/+$/, "");
  setApiBaseUrl(`${trimmed}/h/${encodeURIComponent(state.activeHost)}`);
}

// Subscriber pattern so multiple hooks stay in sync.
type Listener = (s: HostsState) => void;
const listeners = new Set<Listener>();
let state: HostsState = readLocalStorage();

// Apply any persisted selection on first load so the api client points
// at the right place before the first query fires.
if (typeof window !== "undefined") {
  applyBaseUrl(state);
}

function notify(): void {
  for (const l of listeners) l(state);
}

export function setRegistryUrl(url: string): void {
  if (typeof window !== "undefined") {
    if (url) window.localStorage.setItem(REGISTRY_KEY, url);
    else window.localStorage.removeItem(REGISTRY_KEY);
  }
  state = { ...state, registryUrl: url };
  // Changing the registry invalidates the selected host.
  if (!url) {
    state = { ...state, activeHost: null };
    if (typeof window !== "undefined") window.localStorage.removeItem(ACTIVE_KEY);
  }
  applyBaseUrl(state);
  notify();
}

export function setActiveHost(name: string | null): void {
  if (typeof window !== "undefined") {
    if (name) window.localStorage.setItem(ACTIVE_KEY, name);
    else window.localStorage.removeItem(ACTIVE_KEY);
  }
  state = { ...state, activeHost: name };
  applyBaseUrl(state);
  notify();
}

export function useHostState(): HostsState {
  const [snapshot, setSnapshot] = useState<HostsState>(state);
  useEffect(() => {
    const listener: Listener = (s) => setSnapshot(s);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}

export function useRegisteredHosts() {
  const { registryUrl } = useHostState();
  return useQuery<{ hosts: RegisteredHost[] }>({
    enabled: registryUrl.length > 0,
    queryKey: ["hosts", registryUrl],
    queryFn: async () => {
      const trimmed = registryUrl.replace(/\/+$/, "");
      const res = await fetch(`${trimmed}/api/hosts`);
      if (!res.ok) {
        throw new Error(`failed to list hosts: HTTP ${res.status}`);
      }
      return res.json() as Promise<{ hosts: RegisteredHost[] }>;
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

/**
 * Hook that returns a function to switch the active host AND invalidate
 * all dashboard queries so the UI refreshes against the new upstream.
 */
export function useSwitchHost() {
  const queryClient = useQueryClient();
  return useCallback(
    (name: string | null) => {
      setActiveHost(name);
      // Blow away everything so every panel re-fetches from the new host.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );
}
