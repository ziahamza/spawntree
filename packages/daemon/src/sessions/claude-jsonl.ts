import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, SessionTurnData } from "spawntree-core";

/**
 * Parser for the on-disk Claude CLI session transcripts (`.jsonl`).
 *
 * Why this exists: the spawntree catalog persists `turn_started` /
 * `turn_completed` lifecycle events but deliberately skips `message_delta`
 * chunks to avoid write amplification. Final turn content is hydrated from
 * the in-memory adapter via `hydrateTurnContent` after each `turn_completed` —
 * which works only while the daemon is alive. Sessions whose lifetime ended
 * with a previous daemon process leave behind catalog rows with `content: []`
 * and no way to repopulate them from the agent (the subprocess is long gone).
 *
 * Claude CLI itself writes a complete transcript to
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. That file is the
 * authoritative source for historical conversation content. This module
 * parses it into spawntree's `SessionTurnData` shape so adopted sessions can
 * render their full history in the Studio.
 *
 * Format (one JSON object per line, observed from claude-code-acp 2.x):
 *
 *   { "type": "user",       "message": { "role": "user",      "content": [{ "type": "text", "text": "..." }] }, "timestamp": "..." }
 *   { "type": "assistant",  "message": { "role": "assistant", "content": [{ "type": "text", "text": "..." }, { "type": "tool_use", ... }] }, "timestamp": "..." }
 *   { "type": "queue-operation", ... }   // skipped — internal scheduling
 *   { "type": "progress", ... }          // skipped — token usage updates
 *   { "type": "system", ... }            // skipped — tool announcements
 *
 * v1 carries text blocks only. `tool_use` / `tool_result` are skipped here
 * because spawntree models them as separate `SessionToolCallData` rows, not
 * as items in `SessionTurnData.content` — that mapping is a follow-up.
 */

/**
 * Encode a working directory the way Claude CLI does it: `/` → `-`, leading
 * separator included. `/Users/montes/foo/bar` becomes `-Users-montes-foo-bar`.
 */
function encodeCwdAsProjectFolder(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Locate the on-disk transcript for a given session, if one exists. Returns
 * `null` when the file is missing — the caller falls back to whatever the
 * catalog has.
 */
export function resolveClaudeJsonlPath(cwd: string, sessionId: string): string | null {
  const folder = encodeCwdAsProjectFolder(cwd);
  const path = join(homedir(), ".claude", "projects", folder, `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

interface JsonlMessageEvent {
  type: "user" | "assistant";
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  timestamp?: string;
}

/**
 * Parse a Claude CLI `.jsonl` transcript into a list of `SessionTurnData`.
 *
 * Each user/assistant message line becomes one turn. Lines whose only content
 * blocks are `tool_use` / `tool_result` (no `text`) are skipped — they would
 * render as empty bubbles in the Studio and add noise without information.
 *
 * Returns an empty array on file read errors or fully unparseable input
 * rather than throwing, so a corrupt transcript can't abort daemon boot.
 */
export function parseClaudeJsonl(jsonlPath: string, sessionId: string) {
  // Return type intentionally inferred from the literal — declaring
  // `: SessionTurnData[]` resolves to the Effect Schema variant in
  // spawntree-core (readonly arrays), which then can't flow into
  // `AdoptedSession.turns` (mutable). Letting TS infer keeps the
  // literal's mutability and preserves structural compatibility.
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n");
  const turns = [] as Array<{
    id: string;
    turnIndex: number;
    role: SessionTurnData["role"];
    content: ContentBlock[];
    modelId: string | null;
    durationMs: number | null;
    stopReason: string | null;
    status: SessionTurnData["status"];
    errorMessage: string | null;
    createdAt: string;
  }>;
  let turnIndex = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Tolerate single corrupt line — agent may have crashed mid-write.
      continue;
    }

    if (!isMessageEvent(event)) continue;

    const role: SessionTurnData["role"] = event.type === "user" ? "user" : "assistant";
    const sourceContent = event.message?.content ?? [];

    const content: ContentBlock[] = [];
    for (const block of sourceContent) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        content.push({ type: "text", text: block.text });
      }
      // tool_use / tool_result intentionally skipped — see header comment.
    }

    if (content.length === 0) continue;

    turns.push({
      id: `${sessionId}-jsonl-${turnIndex}`,
      turnIndex,
      role,
      content,
      modelId: null,
      durationMs: null,
      stopReason: null,
      status: "completed",
      errorMessage: null,
      createdAt: event.timestamp ?? new Date().toISOString(),
    });
    turnIndex += 1;
  }

  return turns;
}

function isMessageEvent(value: unknown): value is JsonlMessageEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown };
  return v.type === "user" || v.type === "assistant";
}
