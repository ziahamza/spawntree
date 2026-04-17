import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Send, StopCircle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ToolCallTimeline } from "../components/ToolCallTimeline";
import { TurnContent } from "../components/TurnContent";
import {
  type SessionToolCall,
  type SessionTurn,
  useDeleteSession,
  useInterruptSession,
  useSendSessionMessage,
  useSession,
  useSessionEventStream,
} from "../lib/api";

/**
 * Schema.Type gives us deeply `readonly` types. The merge logic needs
 * to mutate while building the overlay. These are fully-mutable working
 * aliases that match the shape; we cast from the wire type once at the
 * boundary and treat them as write-capable inside the merge. Components
 * downstream only read, so the widening from `readonly` → mutable is
 * invisible to them.
 */
type MutableContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | {
      type: "terminal";
      command: string;
      output: string;
      exitCode: number | null;
      durationMs: number | null;
    };
type MutableTurn = {
  id: string;
  turnIndex: number;
  role: "user" | "assistant";
  content: MutableContentBlock[];
  modelId: string | null;
  durationMs: number | null;
  stopReason: string | null;
  status: "streaming" | "completed" | "error" | "cancelled";
  errorMessage: string | null;
  createdAt: string;
};
type MutableToolCall = {
  id: string;
  turnId: string | null;
  toolName: string;
  toolKind: "terminal" | "file_edit" | "mcp" | "other";
  status: "pending" | "in_progress" | "completed" | "error";
  arguments: unknown;
  result: unknown;
  durationMs: number | null;
  createdAt: string;
};

export const Route = createFileRoute("/sessions/$id")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useSession(id);
  const { events, connected, error: streamError } = useSessionEventStream(id);
  const send = useSendSessionMessage(id);
  const interrupt = useInterruptSession(id);
  const del = useDeleteSession();
  const navigate = Route.useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Merge live event deltas onto the turn snapshot from getSession.
  // The snapshot is our base; we overlay streaming text from
  // message_delta events onto the assistant turn keyed by turnId, and
  // append tool call rows as events arrive.
  const { turns, toolCalls, activeTurnId } = useMemo(
    () => mergeSnapshotWithEvents(data?.turns ?? [], data?.toolCalls ?? [], events),
    [data, events],
  );

  // Keep scroll pinned to the bottom while streaming.
  useEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    // Only auto-scroll if the user is near the bottom already (50px
    // tolerance). If they scrolled up to re-read something, don't yank
    // them back.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="h-6 w-48 bg-surface rounded animate-pulse mb-4" />
        <div className="h-32 bg-surface border border-border rounded animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Link
          to="/sessions"
          className="text-xs text-muted hover:text-foreground flex items-center gap-1 mb-3"
        >
          <ArrowLeft className="w-3 h-3" /> back to sessions
        </Link>
        <p className="text-red-400 text-sm">{error.message}</p>
      </div>
    );
  }

  if (!data) return null;

  const session = data.session;
  const isStreaming = session.status === "streaming" || activeTurnId !== null;

  const onSend = async (content: string) => {
    if (!content.trim() || isStreaming) return;
    try {
      await send.mutateAsync({ content });
    } catch (e) {
      console.error("send failed", e);
    }
  };

  const onInterrupt = () => {
    void interrupt.mutateAsync().catch((e) => console.error("interrupt failed", e));
  };

  const onDelete = async () => {
    if (
      !confirm(
        "Delete this session? Claude Code sessions are removed from memory; Codex threads stay in the agent.",
      )
    )
      return;
    try {
      await del.mutateAsync(id);
      void navigate({ to: "/sessions" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Codex returns 501 — surface it.
      alert(msg);
    }
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Main conversation column */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <header className="flex-shrink-0 border-b border-border bg-surface/60 px-4 py-3 flex items-center gap-3">
          <Link
            to="/sessions"
            className="text-xs text-muted hover:text-foreground flex items-center gap-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">sessions</span>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-medium text-foreground truncate">
              {session.title ?? <span className="italic text-muted">untitled</span>}
            </h1>
            <div className="text-[11px] text-muted truncate font-mono">
              {session.provider} · {session.workingDirectory}
              {session.gitBranch && <> · {session.gitBranch}</>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <ConnectionDot connected={connected} error={streamError} />
            {isStreaming && (
              <button
                type="button"
                onClick={onInterrupt}
                disabled={interrupt.isPending}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors"
                title="Stop the current turn"
              >
                <StopCircle className="w-3 h-3" /> interrupt
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              disabled={del.isPending}
              className="p-1.5 text-muted hover:text-red-400 transition-colors rounded"
              title="Delete session"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
          <div className="max-w-3xl mx-auto divide-y divide-border">
            {turns.length === 0 ? (
              <div className="py-10 text-center text-xs text-muted italic">
                No turns yet. Send a message below to get started.
              </div>
            ) : (
              turns.map((t) => <TurnContent key={t.id} turn={t} />)
            )}
          </div>
        </div>

        <Composer onSend={onSend} isStreaming={isStreaming} disabled={send.isPending} />
      </main>

      {/* Tool call sidebar (hidden on mobile) */}
      <aside className="hidden lg:flex w-72 flex-shrink-0 border-l border-border bg-surface/40 flex-col">
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">Tool calls</h2>
          <p className="text-[10px] text-muted mt-0.5">{toolCalls.length} total</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <ToolCallTimeline toolCalls={toolCalls} />
        </div>
      </aside>
    </div>
  );
}

function ConnectionDot({ connected, error }: { connected: boolean; error: Error | null }) {
  if (error) {
    return (
      <span className="text-[10px] text-red-400" title={error.message}>
        • disconnected
      </span>
    );
  }
  if (!connected) {
    return <span className="text-[10px] text-muted">• idle</span>;
  }
  return (
    <span className="text-[10px] text-green-400 flex items-center gap-1">
      <span className="w-1 h-1 rounded-full bg-green-400 animate-pulse" />
      live
    </span>
  );
}

function Composer({
  onSend,
  isStreaming,
  disabled,
}: {
  onSend: (content: string) => void | Promise<void>;
  isStreaming: boolean;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    void onSend(trimmed);
    setValue("");
    // Keep focus in the composer after sending.
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts newline; Cmd/Ctrl+Enter also sends.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Auto-resize the textarea (cap at ~8 lines).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="flex-shrink-0 border-t border-border bg-surface/60 px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isStreaming
                ? "Agent is responding — interrupt to send a new message"
                : "Ask the agent anything. Enter to send, Shift+Enter for a new line."
            }
            rows={1}
            disabled={isStreaming}
            className="flex-1 px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted focus:outline-none focus:border-foreground/40 resize-none font-sans disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || isStreaming || !value.trim()}
            className="flex items-center gap-1 px-3 py-2 text-xs rounded-md border border-foreground/40 bg-foreground/10 text-foreground hover:bg-foreground/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
        </div>
        <div className="mt-1.5 text-[10px] text-muted flex justify-between">
          <span>Enter to send · Shift+Enter for newline</span>
          {isStreaming && <span className="text-yellow-400">Turn in progress…</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Overlay live SSE events onto a REST-fetched snapshot.
 *
 * The snapshot is the "durable" state from GET /api/v1/sessions/:id —
 * complete turns, completed tool calls. The event stream carries
 * message_delta (text chunks), tool_call_started, tool_call_completed,
 * turn_started, turn_completed, session_status_changed.
 *
 * We merge these by:
 *   1. Starting from the snapshot's turns and tool calls.
 *   2. For each message_delta, creating (if missing) or updating (if
 *      present) an assistant turn for that turnId by appending the
 *      delta's text to the last text block.
 *   3. For each tool_call_started / tool_call_completed, upserting
 *      into the tool calls list by id.
 *   4. Tracking activeTurnId from turn_started / turn_completed so the
 *      header + composer know whether a turn is in flight.
 *
 * This is intentionally simple — we trust the snapshot refetches
 * periodically (react-query every 30s) to repair any inconsistency.
 */
function mergeSnapshotWithEvents(
  snapshotTurns: readonly SessionTurn[],
  snapshotTools: readonly SessionToolCall[],
  events: ReturnType<typeof useSessionEventStream>["events"],
): {
  turns: MutableTurn[];
  toolCalls: MutableToolCall[];
  activeTurnId: string | null;
} {
  // Deep-copy readonly snapshot structures into mutable working copies.
  // We'll mutate these as events arrive, then return them to components
  // that only read. The variance is safe because the read side never
  // observes the mutation boundary.
  const turns: MutableTurn[] = snapshotTurns.map((t) => ({
    ...t,
    content: t.content.map((b) => ({ ...b })),
  })) as MutableTurn[];
  const toolCalls: MutableToolCall[] = snapshotTools.map((t) => ({ ...t }));
  let activeTurnId: string | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case "turn_started":
        activeTurnId = ev.turnId;
        break;
      case "turn_completed":
        if (activeTurnId === ev.turnId) activeTurnId = null;
        // Mark the matching assistant turn as completed (best-effort).
        for (const t of turns) {
          if (t.id.startsWith(`${ev.turnId}-`) && t.role === "assistant") {
            t.status =
              ev.status === "completed" || ev.status === "end_turn"
                ? "completed"
                : ev.status.startsWith("error")
                  ? "error"
                  : "completed";
          }
        }
        break;
      case "message_delta": {
        // Find-or-create the assistant turn for this turnId.
        const recordId = `${ev.turnId}-agent`;
        let turn = turns.find((t) => t.id === recordId);
        if (!turn) {
          turn = {
            id: recordId,
            turnIndex: turns.length,
            role: "assistant",
            content: [{ type: "text", text: "" }],
            modelId: null,
            durationMs: null,
            stopReason: null,
            status: "streaming",
            errorMessage: null,
            createdAt: new Date().toISOString(),
          };
          turns.push(turn);
        }
        const last = turn.content[turn.content.length - 1];
        if (last && last.type === "text") {
          last.text += ev.text;
        } else {
          turn.content.push({ type: "text", text: ev.text });
        }
        break;
      }
      case "tool_call_started": {
        const exists = toolCalls.find((t) => t.id === ev.toolCall.id);
        if (!exists) toolCalls.push(ev.toolCall);
        break;
      }
      case "tool_call_completed": {
        const idx = toolCalls.findIndex((t) => t.id === ev.toolCall.id);
        if (idx === -1) toolCalls.push(ev.toolCall);
        else toolCalls[idx] = ev.toolCall;
        break;
      }
      case "session_status_changed":
        // Session-level status is tracked by the REST snapshot.
        break;
    }
  }

  return { turns, toolCalls, activeTurnId };
}
