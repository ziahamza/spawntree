import { Activity, Check, FileEdit, Plug, Terminal as TerminalIcon, X } from "lucide-react";
import type { SessionToolCall } from "../lib/api";

/**
 * Parallel column showing every tool call the agent made, chronologically.
 * Groups by turnId so you can see which prompts produced which actions.
 *
 * Kept minimal: icon, tool name, status dot, optional duration. Clicking
 * to expand args/result is a v2 feature — not in the critical path for
 * "can I verify the session works end-to-end."
 */
export function ToolCallTimeline({ toolCalls }: { toolCalls: SessionToolCall[] }) {
  if (toolCalls.length === 0) {
    return <div className="text-xs text-muted italic py-4 text-center">No tool calls yet.</div>;
  }

  return (
    <ol className="space-y-1">
      {toolCalls.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}
    </ol>
  );
}

function ToolCallRow({ toolCall }: { toolCall: SessionToolCall }) {
  const Icon = iconForKind(toolCall.toolKind);
  return (
    <li className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface/60 text-xs">
      <Icon className="w-3 h-3 text-muted flex-shrink-0" />
      <span className="font-mono text-foreground truncate flex-1 min-w-0">{toolCall.toolName}</span>
      <StatusBadge status={toolCall.status} />
      {toolCall.durationMs !== null && (
        <span className="text-[10px] text-muted font-mono">
          {formatDuration(toolCall.durationMs)}
        </span>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: SessionToolCall["status"] }) {
  switch (status) {
    case "pending":
      return (
        <span className="text-[10px] text-muted flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-muted" />
          pending
        </span>
      );
    case "in_progress":
      return (
        <span className="text-[10px] text-yellow-400 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
          running
        </span>
      );
    case "completed":
      return <Check className="w-3 h-3 text-green-400" />;
    case "error":
      return <X className="w-3 h-3 text-red-400" />;
  }
}

function iconForKind(kind: SessionToolCall["toolKind"]) {
  switch (kind) {
    case "terminal":
      return TerminalIcon;
    case "file_edit":
      return FileEdit;
    case "mcp":
      return Plug;
    default:
      return Activity;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
