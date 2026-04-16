import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AddFolderDialog } from "../components/AddFolderDialog";
import { HostSwitcher } from "../components/HostSwitcher";
import { RepoTree } from "../components/RepoTree";
import { debugLog } from "../lib/debug";
import { createApiEventSource, useDaemonInfo } from "../lib/api";
import { useHostState } from "../lib/hosts";
import "../styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000,
      staleTime: 2000,
    },
  },
});

export const Route = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <LiveUpdates />
      <RootComponent />
    </QueryClientProvider>
  ),
});

function LiveUpdates() {
  const queryClient = useQueryClient();
  // Re-subscribe whenever the user switches hosts so SSE follows the
  // active daemon rather than staying pinned to the original origin.
  const { activeHost, registryUrl } = useHostState();

  useEffect(() => {
    const eventSource = createApiEventSource();
    debugLog("events", "connect", { activeHost, registryUrl });

    eventSource.onmessage = (event) => {
      let parsed: { type?: string; repoSlug?: string; repoId?: string } | null = null;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // fall through
      }

      debugLog("events", "message", parsed ?? event.data);

      switch (parsed?.type) {
        case "infra.updated":
          void queryClient.invalidateQueries({ queryKey: ["infra"] });
          break;
        case "repo.updated":
          void queryClient.invalidateQueries({ queryKey: ["web", "repos"] });
          if (parsed.repoSlug) {
            void queryClient.invalidateQueries({ queryKey: ["web", "repos", parsed.repoSlug] });
          }
          break;
        case "env.updated":
        case "env.deleted":
          void queryClient.invalidateQueries({ queryKey: ["envs"] });
          void queryClient.invalidateQueries({ queryKey: ["web", "repos"] });
          if (parsed.repoSlug) {
            void queryClient.invalidateQueries({ queryKey: ["web", "repos", parsed.repoSlug] });
          }
          if (parsed.repoId) {
            void queryClient.invalidateQueries({ queryKey: ["repos", parsed.repoId] });
          }
          break;
        default:
          void queryClient.invalidateQueries({ queryKey: ["daemon"] });
      }
    };

    eventSource.onerror = () => {
      debugLog("events", "error");
    };

    return () => {
      debugLog("events", "close");
      eventSource.close();
    };
  }, [queryClient, activeHost, registryUrl]);

  return null;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void; }) {
  const [addOpen, setAddOpen] = useState(false);
  const { data: daemon } = useDaemonInfo();

  return (
    <>
      <div className="p-4 border-b border-border flex flex-col gap-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold font-display text-foreground">spawntree</h1>
            <span className="text-xs text-muted">{daemon?.version ?? "…"}</span>
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className="px-2.5 py-1 text-xs rounded-md border border-border bg-surface text-muted hover:text-foreground hover:border-foreground/30 transition-colors min-h-[30px]"
          >
            + Add
          </button>
        </div>
        {/* Host-switcher: lets one dashboard talk to multiple spawntree
            daemons via a federation host-server. See examples/host-server. */}
        <HostSwitcher />
      </div>
      <div className="flex-1 overflow-y-auto">
        <RepoTree onNavigate={onNavigate} />
      </div>

      <AddFolderDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function RootComponent() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background text-foreground font-sans overflow-hidden">
      {/* Desktop sidebar (lg+) */}
      <aside className="hidden lg:flex w-60 flex-shrink-0 border-r border-border bg-surface flex-col">
        <SidebarContent />
      </aside>

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Mobile drawer panel */}
      <aside
        className={`lg:hidden fixed inset-y-0 left-0 z-50 w-72 bg-surface border-r border-border flex flex-col transition-transform duration-200 ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-end p-2 border-b border-border">
          <button
            onClick={() => setDrawerOpen(false)}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-md"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto flex flex-col">
          <SidebarContent onNavigate={() => setDrawerOpen(false)} />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-surface flex-shrink-0">
          <button
            onClick={() => setDrawerOpen(true)}
            className="p-2 text-muted hover:text-foreground transition-colors rounded-md min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-display font-semibold text-sm text-foreground">spawntree</span>
        </div>

        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
