import { Terminal, User } from "lucide-react";
import type { SessionTurn } from "../lib/api";

/**
 * Renders a single turn — user or assistant — with all its content
 * blocks. Content blocks are the normalized union from ACPAdapter:
 * text, image, diff, terminal. Each block gets its own presentation.
 *
 * Kept deliberately dumb: no markdown parsing, no syntax highlighting,
 * no fancy diff viewer. Plain typography, monospace for code-ish
 * content. We can layer polish later (t3code-style) without touching
 * the contract.
 */
export function TurnContent({ turn }: { turn: SessionTurn }) {
  const isUser = turn.role === "user";
  const isStreaming = turn.status === "streaming";
  const isError = turn.status === "error";

  return (
    <div className="group flex gap-3 py-3">
      <div className="flex-shrink-0 w-6 pt-0.5">
        {isUser ? (
          <User className="w-4 h-4 text-muted" />
        ) : (
          <div className="w-4 h-4 rounded-sm bg-foreground/10 flex items-center justify-center text-[10px] font-mono text-muted">
            A
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-xs font-medium text-foreground">{isUser ? "You" : "Agent"}</span>
          {isStreaming && (
            <span className="text-[10px] text-muted">
              <span className="inline-block w-1 h-1 rounded-full bg-green-400 animate-pulse mr-1" />
              streaming
            </span>
          )}
          {isError && (
            <span className="text-[10px] text-red-400">
              error{turn.errorMessage ? `: ${turn.errorMessage}` : ""}
            </span>
          )}
          {turn.modelId && <span className="text-[10px] text-muted font-mono">{turn.modelId}</span>}
        </div>
        <div className="space-y-2 text-sm text-foreground leading-relaxed">
          {turn.content.map((block, i) => (
            <ContentBlockView key={i} block={block} />
          ))}
          {turn.content.length === 0 && isStreaming && (
            <div className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/40 animate-pulse" />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:150ms]" />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:300ms]" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ContentBlockView({ block }: { block: SessionTurn["content"][number] }) {
  switch (block.type) {
    case "text":
      return <div className="whitespace-pre-wrap break-words">{block.text}</div>;
    case "image":
      return (
        <img
          src={`data:${block.mimeType};base64,${block.data}`}
          alt=""
          className="max-w-full rounded border border-border"
        />
      );
    case "diff":
      return (
        <div className="rounded border border-border bg-background/50 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border bg-surface text-[11px] font-mono text-muted">
            {block.path}
          </div>
          <pre className="px-3 py-2 text-[11px] font-mono overflow-x-auto leading-relaxed">
            {block.newText}
          </pre>
        </div>
      );
    case "terminal":
      return (
        <div className="rounded border border-border bg-background/50 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border bg-surface flex items-center gap-2">
            <Terminal className="w-3 h-3 text-muted" />
            <span className="text-[11px] font-mono text-foreground/90">{block.command}</span>
            {block.exitCode !== null && block.exitCode !== 0 && (
              <span className="ml-auto text-[10px] text-red-400 font-mono">
                exit {block.exitCode}
              </span>
            )}
            {block.durationMs !== null && (
              <span className="text-[10px] text-muted font-mono">
                {formatDuration(block.durationMs)}
              </span>
            )}
          </div>
          {block.output && (
            <pre className="px-3 py-2 text-[11px] font-mono overflow-x-auto text-muted leading-relaxed max-h-64">
              {block.output}
            </pre>
          )}
        </div>
      );
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
