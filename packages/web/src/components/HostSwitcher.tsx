import { ChevronDown, Globe, Monitor, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { setRegistryUrl, useHostState, useRegisteredHosts, useSwitchHost } from "../lib/hosts";

/**
 * Dropdown that picks which spawntree daemon the dashboard talks to.
 *
 * Two modes:
 *   - Local (always available) — same-origin, the daemon serving this bundle.
 *   - Remote — any host registered in a federation host registry
 *     (see `spawntree-host` package). User enters the registry URL once and
 *     it's persisted to localStorage.
 */
export function HostSwitcher() {
  const { registryUrl, activeHost } = useHostState();
  const { data, isFetching, error } = useRegisteredHosts();
  const switchHost = useSwitchHost();

  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [draftUrl, setDraftUrl] = useState(registryUrl);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
      setConfiguring(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) setConfiguring(false);
    if (open) setDraftUrl(registryUrl);
  }, [open, registryUrl]);

  const hosts = data?.hosts ?? [];
  const activeLabel = activeHost
    ? (hosts.find((h) => h.name === activeHost)?.label ?? activeHost)
    : "local";

  const onSelectLocal = () => {
    switchHost(null);
    setOpen(false);
  };

  const onSelectRemote = (name: string) => {
    switchHost(name);
    setOpen(false);
  };

  const onSaveRegistry = () => {
    const trimmed = draftUrl.trim();
    setRegistryUrl(trimmed);
    setConfiguring(false);
    if (!trimmed) setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border border-border bg-surface text-muted hover:text-foreground hover:border-foreground/30 transition-colors max-w-[160px]"
        title={activeHost ? `Connected to ${activeHost}` : "Connected to local daemon"}
      >
        {activeHost ? <Globe className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
        <span className="truncate">{activeLabel}</span>
        <ChevronDown className="w-3 h-3 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 rounded-md border border-border bg-surface shadow-lg z-50 overflow-hidden">
          {/* Local daemon — always present */}
          <button
            type="button"
            onClick={onSelectLocal}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-background/40 transition-colors ${
              activeHost === null ? "text-foreground" : "text-muted"
            }`}
          >
            <Monitor className="w-3.5 h-3.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">local</div>
              <div className="text-[10px] text-muted">same-origin daemon</div>
            </div>
            {activeHost === null && <span className="text-[10px] text-foreground">●</span>}
          </button>

          {/* Remote hosts, if a registry is configured */}
          {registryUrl && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted border-t border-border bg-background/20">
                remote hosts
                {isFetching && <span className="ml-1 text-[9px]">…</span>}
              </div>
              {error && (
                <div className="px-3 py-2 text-[11px] text-red-400">registry unreachable</div>
              )}
              {hosts.length === 0 && !error && !isFetching && (
                <div className="px-3 py-2 text-[11px] text-muted">no hosts registered</div>
              )}
              {hosts.map((h) => (
                <button
                  key={h.name}
                  type="button"
                  onClick={() => onSelectRemote(h.name)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-background/40 transition-colors ${
                    activeHost === h.name ? "text-foreground" : "text-muted"
                  }`}
                >
                  <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{h.label ?? h.name}</div>
                    <div className="text-[10px] text-muted truncate">{h.url}</div>
                  </div>
                  {activeHost === h.name && <span className="text-[10px] text-foreground">●</span>}
                </button>
              ))}
            </>
          )}

          {/* Registry config */}
          <div className="border-t border-border">
            {!configuring ? (
              <button
                type="button"
                onClick={() => setConfiguring(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-muted hover:text-foreground hover:bg-background/40 transition-colors"
              >
                <Settings className="w-3 h-3" />
                {registryUrl ? "Change host registry…" : "Configure host registry…"}
              </button>
            ) : (
              <div className="p-2 space-y-2">
                <div className="text-[10px] text-muted">Host-server registry URL</div>
                <input
                  type="text"
                  value={draftUrl}
                  onChange={(e) => setDraftUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7777"
                  className="w-full px-2 py-1 text-xs rounded border border-border bg-background text-foreground placeholder:text-muted focus:outline-none focus:border-foreground/40"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveRegistry();
                    if (e.key === "Escape") setConfiguring(false);
                  }}
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={onSaveRegistry}
                    className="flex-1 px-2 py-1 text-[11px] rounded border border-border bg-surface text-foreground hover:border-foreground/40 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftUrl("");
                      setRegistryUrl("");
                      setConfiguring(false);
                    }}
                    className="px-2 py-1 text-[11px] rounded border border-border text-muted hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                </div>
                <div className="text-[10px] text-muted leading-relaxed">
                  Run the federation server from{" "}
                  <code className="text-foreground/70">spawntree-host</code> and register daemons.
                  Stored in this browser only.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
