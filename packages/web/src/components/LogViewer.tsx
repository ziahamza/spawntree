import { useCallback, useEffect, useRef, useState } from "react";

interface LogLine {
  ts: string;
  service: string;
  message: string;
  isError: boolean;
}

interface LogViewerProps {
  repoID: string;
  envID: string;
  repoPath?: string;
  activeService?: string | null;
}

function parseLogLine(raw: string): LogLine {
  // The server sends JSON-encoded LogLine objects: {ts, service, stream, line}
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.line === "string") {
      const isError = /error|err|fatal|panic/i.test(parsed.line) || parsed.stream === "stderr";
      return {
        ts: parsed.ts ?? "",
        service: parsed.service ?? "",
        message: parsed.line,
        isError,
      };
    }
  } catch {
    // Not JSON, fall through to plain-text parsing
  }
  // Fallback: try to parse structured log: "[HH:MM:SS] service: message"
  const m = raw.match(/^\[([^\]]+)\]\s+(\S+):\s+(.*)$/);
  if (m) {
    const [, ts, service, message] = m;
    const isError =
      /error|err|fatal|panic/i.test(message) || /error|err|fatal|panic/i.test(service);
    return { ts, service, message, isError };
  }
  // Fallback: no structure
  const isError = /error|err|fatal|panic/i.test(raw);
  return { ts: "", service: "", message: raw, isError };
}

export function LogViewer({ repoID, envID, repoPath, activeService }: LogViewerProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [services, setServices] = useState<string[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNewLogs, setHasNewLogs] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Propagate activeService as filter
  useEffect(() => {
    if (activeService !== undefined) setFilter(activeService);
  }, [activeService]);

  // SSE connection
  useEffect(() => {
    if (!repoID || !envID) return;

    const url = `/api/v1/repos/${repoID}/envs/${envID}/logs${
      repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ""
    }`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (event: MessageEvent) => {
      const line = parseLogLine(event.data as string);
      setLines((prev) => [...prev, line]);
      setServices((prev) => {
        if (line.service && !prev.includes(line.service)) return [...prev, line.service];
        return prev;
      });
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [repoID, envID, repoPath]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      setHasNewLogs(false);
    } else {
      setHasNewLogs(true);
    }
  }, [lines, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
    if (isAtBottom) setHasNewLogs(false);
  }, []);

  const scrollToBottom = () => {
    setAutoScroll(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const displayedFilter = activeService !== undefined ? activeService : filter;
  const visibleLines = displayedFilter ? lines.filter((l) => l.service === displayedFilter) : lines;

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-surface flex-shrink-0 overflow-x-auto">
        <button
          onClick={() => setFilter(null)}
          className={`px-3 py-1 rounded-md text-xs font-mono transition-colors min-h-[28px] whitespace-nowrap ${
            !displayedFilter
              ? "bg-blue/20 text-blue border border-blue/30"
              : "text-muted hover:text-foreground border border-transparent hover:border-border"
          }`}
        >
          All
        </button>
        {services.map((svc) => (
          <button
            key={svc}
            onClick={() => setFilter(svc)}
            className={`px-3 py-1 rounded-md text-xs font-mono transition-colors min-h-[28px] whitespace-nowrap ${
              displayedFilter === svc
                ? "bg-blue/20 text-blue border border-blue/30"
                : "text-muted hover:text-foreground border border-transparent hover:border-border"
            }`}
          >
            {svc}
          </button>
        ))}
      </div>

      {/* Log output */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs bg-background p-4 min-h-0"
      >
        {visibleLines.length === 0 ? (
          <p className="text-muted">Waiting for log output…</p>
        ) : (
          visibleLines.map((line, i) => (
            <div
              key={i}
              className={`flex gap-2 leading-5 ${line.isError ? "text-red" : "text-foreground"}`}
            >
              {line.ts && <span className="text-muted flex-shrink-0 select-none">{line.ts}</span>}
              {line.service && (
                <span className="text-blue flex-shrink-0 select-none">{line.service}</span>
              )}
              <span className="break-all">{line.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Disconnected banner */}
      {!connected && lines.length > 0 && (
        <div className="flex-shrink-0 bg-warning-bg border-t border-warning-border text-orange text-xs px-4 py-2 text-center">
          Log stream disconnected
        </div>
      )}

      {/* New logs pill */}
      {hasNewLogs && !autoScroll && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2">
          <button
            onClick={scrollToBottom}
            className="bg-blue text-background text-xs px-3 py-1.5 rounded-full shadow-lg font-sans font-medium"
          >
            New logs below ↓
          </button>
        </div>
      )}
    </div>
  );
}
