import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ContentBlock, SessionTurnData } from "spawntree-core";

/**
 * Root of Claude CLI's on-disk state. Claude Code reads `CLAUDE_CONFIG_DIR`
 * if set, otherwise falls back to `~/.claude`. Mirror that here so the
 * daemon discovers/hydrates transcripts from the same place the agent
 * actually wrote them.
 */
function getClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

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
 * Encode a working directory the way Claude CLI does it: any path
 * separator → `-`, drive-letter colon also normalised. So
 * `/Users/montes/foo/bar` becomes `-Users-montes-foo-bar`, and a native
 * Windows `C:\repo\app` becomes `C--repo-app`. Without normalising the
 * Windows separators and drive-letter colon, the resulting path would
 * never match Claude Code's `~/.claude/projects/<encoded-cwd>/` layout
 * and hydration would silently skip every session running outside WSL.
 */
function encodeCwdAsProjectFolder(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

/**
 * Locate the on-disk transcript for a given session, if one exists. Returns
 * `null` when the file is missing — the caller falls back to whatever the
 * catalog has.
 */
export function resolveClaudeJsonlPath(cwd: string, sessionId: string): string | null {
  const folder = encodeCwdAsProjectFolder(cwd);
  const path = join(getClaudeHome(), "projects", folder, `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

interface JsonlMessageEvent {
  type: "user" | "assistant";
  message?: {
    role?: string;
    // Claude CLI versions diverged on the shape of `content`:
    //   - Older builds and assistant messages: `[{ type: "text", text }, ...]`
    //   - Newer builds (observed in 2.0.42+) for user messages: a bare
    //     string. `parseClaudeJsonl` normalises both into the array form
    //     before producing content blocks; without that, every user turn
    //     in a 2.0.42+ transcript ends up empty and gets dropped.
    content?: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: string;
}

/**
 * Shape of a parsed turn. Identical to `SessionTurnData` from
 * `spawntree-core` but defined inline here to preserve mutable arrays —
 * the public type resolves through the Effect Schema variant which has
 * `readonly` everything, and that doesn't flow into `AdoptedSession.turns`.
 */
type ParsedTurn = {
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
};

const TITLE_MAX_CHARS = 60;

/**
 * Reduce a turn's content blocks to a flat string suitable for use as a
 * title — joins all `text` blocks with spaces, collapses whitespace. Tool
 * blocks are already filtered out at parse time, so this is just a safe
 * accessor on the surviving text content.
 */
function flattenTextContent(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Parse a Claude CLI `.jsonl` transcript.
 *
 * Returns:
 *   - `turns`: each user/assistant message line as one `SessionTurnData`-
 *     shaped object. Lines whose only content blocks are `tool_use` /
 *     `tool_result` (no `text`) are skipped — they would render as empty
 *     bubbles in the Studio and add noise.
 *   - `title`: the first user message's text, truncated, suitable as a
 *     human-friendly thread title. `null` when the transcript has no
 *     user message with text content.
 *
 * Returns empty values on file read errors or fully unparseable input
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
    return {
      turns: [] as ParsedTurn[],
      title: null as string | null,
      startedAt: null as string | null,
      lastActivityAt: null as string | null,
      partialParse: false,
    };
  }

  const lines = raw.split("\n");
  const turns = [] as ParsedTurn[];
  let turnIndex = 0;
  // Tracks JSON.parse failures. The previous behavior silently swallowed
  // them and let the caller treat any non-empty parse as authoritative,
  // which meant a transcript truncated mid-write would replace existing
  // turns with only the parsed prefix — irreversible history loss in
  // the catalog. Callers can now gate the replace on `partialParse`.
  let partialParse = false;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Tolerate single corrupt line — agent may have crashed mid-write.
      partialParse = true;
      continue;
    }

    if (!isMessageEvent(event)) continue;

    const role: SessionTurnData["role"] = event.type === "user" ? "user" : "assistant";
    const rawContent = event.message?.content;
    // Normalise the two shapes Claude CLI uses for `message.content`: a
    // plain string (newer user messages, 2.0.42+) becomes a single text
    // block; an existing array passes through unchanged. Without this,
    // iterating a string with `for...of` walked it character-by-character
    // and every user turn ended up empty + dropped.
    const sourceContent: Array<{ type: string; text?: string }> =
      typeof rawContent === "string" ? [{ type: "text", text: rawContent }] : (rawContent ?? []);

    const content: ContentBlock[] = [];
    let sawToolBlock = false;
    for (const block of sourceContent) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" || block.type === "tool_result") {
        // tool_use / tool_result blocks are intentionally not added to
        // `content` (spawntree models them as separate
        // `SessionToolCallData` rows), but we still need to emit the
        // turn itself when these are the *only* blocks present — the
        // tool calls reference `turn_id`, and skipping the turn
        // leaves those FK references dangling after `replaceSessionTurns`
        // wipes and re-inserts the rows.
        sawToolBlock = true;
      }
    }

    // Drop the turn only when there is literally nothing to anchor —
    // no text content AND no tool blocks. A tool-only assistant turn
    // is kept with `content: []` so `session_tool_calls.turn_id` rows
    // still resolve to a real `session_turns` row after backfill.
    if (content.length === 0 && !sawToolBlock) continue;

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

  // Title = first user message, flattened to a single line and clipped
  // to TITLE_MAX_CHARS. This matches the convention every other AI chat
  // UI uses (Claude.ai, ChatGPT, Cursor) and avoids forcing the user to
  // see "Untitled · Untitled · Untitled · …" everywhere when their own
  // first message is a perfectly serviceable label.
  let title: string | null = null;
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const flat = flattenTextContent(turn.content);
    if (flat.length === 0) continue;
    title = flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS - 1)}…` : flat;
    break;
  }

  // Activity bookends — used by hydration to backfill `started_at` and
  // `updated_at` on the catalog row. Without this, sessions adopted from
  // the catalog inherit whatever timestamp was there (often "boot time"
  // due to legacy upsertSession behavior that bumped on every discovery
  // tick), making them all appear simultaneous in the UI.
  const startedAt = turns[0]?.createdAt ?? null;
  const lastActivityAt = turns[turns.length - 1]?.createdAt ?? null;

  return { turns, title, startedAt, lastActivityAt, partialParse };
}

function isMessageEvent(value: unknown): value is JsonlMessageEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown };
  return v.type === "user" || v.type === "assistant";
}

/**
 * A Claude CLI session found on disk that the spawntree catalog has not
 * (yet) ingested. Produced by `listDiscoverableClaudeSessions` so the
 * SessionManager's discovery pass can decide whether to import it.
 */
export interface DiscoverableClaudeSession {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
}

/**
 * Walk `~/.claude/projects/` and return every `<sessionId>.jsonl` the
 * Claude CLI has written, paired with the `cwd` we believe each was
 * recorded against. Used by the daemon's discovery pass to surface
 * sessions that were never created through the spawntree daemon (e.g.
 * the user ran `claude` directly from a terminal or the Claude Code
 * IDE), so they can be imported into the catalog and shown alongside
 * daemon-created sessions in the Studio.
 *
 * The folder-name → cwd decode is **best-effort**:
 *   - Unix paths encode unambiguously when they have no hyphens in the
 *     original: every `/` becomes `-`, so we replace `-` with `/`.
 *   - Folders whose decoded path doesn't exist on disk are skipped
 *     (covers Windows paths — `C:\foo` → `C--foo`, irreversible — and
 *     legitimate Unix cwds with hyphens in the original folder name,
 *     where the decoded path resolves to a different real directory or
 *     to none at all).
 *
 * Returns `[]` when the projects root is missing (Claude CLI never
 * ran on this machine).
 */
export function listDiscoverableClaudeSessions(): DiscoverableClaudeSession[] {
  const projectsRoot = join(getClaudeHome(), "projects");
  if (!existsSync(projectsRoot)) return [];

  const out: DiscoverableClaudeSession[] = [];
  let folders: string[];
  try {
    folders = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  for (const folder of folders) {
    const folderPath = join(projectsRoot, folder);
    let entries: string[];
    try {
      const stat = statSync(folderPath);
      if (!stat.isDirectory()) continue;
      entries = readdirSync(folderPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = basename(entry, ".jsonl");
      if (sessionId.length === 0) continue;
      const jsonlPath = join(folderPath, entry);
      // Read cwd from the transcript itself rather than decoding the
      // folder name. The encoder is one-way lossy (collapses `/`, `\`,
      // `:` to `-`), so any folder-name reverse is ambiguous: a real
      // path containing hyphens (`/Users/me/my-project`) round-trips
      // to a different path (`/Users/me/my/project`) that might also
      // exist, attaching the session to the wrong checkout. Claude
      // Code writes the original `cwd` field on every JSONL line, so
      // reading it directly is both unambiguous and cross-platform
      // (Windows-encoded folders like `C--repo-app` work the same).
      const cwd = readCwdFromTranscript(jsonlPath);
      if (!cwd) continue;
      out.push({ sessionId, jsonlPath, cwd });
    }
  }
  return out;
}

/**
 * Read the original working directory from a Claude transcript. Each
 * JSONL line includes a `cwd` field on the top-level event object;
 * the first parseable line is authoritative (cwd doesn't change
 * mid-session). Returns `null` for unreadable files or transcripts
 * without `cwd` (very old Claude CLI versions, or files written by
 * something other than the agent).
 */
function readCwdFromTranscript(jsonlPath: string): string | null {
  // The cwd lives on the first JSON line, so read only the head of the file
  // instead of the whole thing. This runs for EVERY discoverable session on
  // the boot discovery pass, and transcripts run to tens of MB — reading them
  // all in full blocked the event loop long enough to abort the Turso sync and
  // starve the heartbeat on a machine with a large history.
  let head: string;
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of head.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown };
      if (typeof parsed.cwd === "string" && parsed.cwd.length > 0) {
        return parsed.cwd;
      }
    } catch {
      // Corrupt line, or a line truncated at the 64KB head boundary — keep
      // scanning the lines we did read (the cwd is on the first line anyway).
    }
  }
  return null;
}
