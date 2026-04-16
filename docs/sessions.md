# Agent Sessions

Spawntree's daemon can drive AI coding agents (Claude Code, Codex) as
first-class sessions. Each session is a live conversation with an agent
subprocess: you send messages, stream turn events, and inspect tool calls just
like you would in the agent's native CLI.

This page covers:

- The HTTP API
- The typed TypeScript SDK (`ApiClient`)
- Providers and how they're resolved
- Permission policy
- Extending with custom providers
- Putting sessions next to isolated envs

## What you get

- **Two providers out of the box:** `claude-code` (via
  `@zed-industries/claude-code-acp`) and `codex` (via
  `codex app-server --listen stdio://`).
- **One normalized event stream.** Both agents stream `turn_started`,
  `message_delta`, `tool_call_started`, `tool_call_completed`, `turn_completed`,
  and `session_status_changed`. Wire format is identical.
- **SSE transport.** Subscribe to events over `GET /api/v1/sessions/:id/events`
  or read them alongside infra events on the main `/api/v1/events` stream.
- **Typed SDK.** `spawntree-core` exports an `ApiClient` with 7 session methods
  that return Effect-validated responses.

## HTTP API

All routes live under `/api/v1/sessions`.

### Create a session

```http
POST /api/v1/sessions
Content-Type: application/json

{ "provider": "claude-code", "cwd": "/path/to/repo", "mcpServers": [] }
```

Returns `201 Created`:

```json
{ "sessionId": "sess-abc123", "provider": "claude-code" }
```

Codex sessions are created implicitly — call `POST` there and the adapter
returns `400 Bad Request` with `code: "PROVIDER_CAPABILITY_MISSING"` and
`details.capability: "createSession"`. To talk to Codex, use its CLI to start a
thread, then list via `GET /api/v1/sessions`.

### List sessions

```http
GET /api/v1/sessions
```

Returns all known sessions across available providers. Adapters whose binary
isn't installed are skipped silently (no subprocess spawn).

```json
{
  "sessions": [
    {
      "sessionId": "sess-abc123",
      "provider": "claude-code",
      "status": "idle",
      "title": "Refactor auth",
      "workingDirectory": "/path/to/repo",
      "gitBranch": "main",
      "gitHeadCommit": "0123abc",
      "gitRemoteUrl": "https://github.com/you/repo",
      "totalTurns": 3,
      "startedAt": "2026-04-16T12:00:00Z",
      "updatedAt": "2026-04-16T12:05:00Z"
    }
  ]
}
```

`totalTurns` is normalized across providers to mean "number of user messages
sent in this session". One user message + its agent response is one turn.

### Get session detail

```http
GET /api/v1/sessions/:id
```

Returns the session info plus every turn and every tool call, with fully
resolved content blocks (`text`, `image`, `diff`, `terminal`).

### Send a message

```http
POST /api/v1/sessions/:id/messages
Content-Type: application/json

{ "content": "explain this function" }
```

Starts a new turn. Returns immediately with `{ "ok": true }` — follow the
session's SSE stream for streaming output.

If the session already has a turn in flight, this returns **`409 Conflict`**
with `code: "SESSION_BUSY"` and the active turn id. Interrupt the active turn
first:

```http
POST /api/v1/sessions/:id/interrupt
```

### Stream events

```http
GET /api/v1/sessions/:id/events
Accept: text/event-stream
```

SSE stream of `SessionEventPayload` events scoped to that session. History
replay is filtered — a fresh subscriber won't receive events from unrelated
sessions that happened to be in the 64-event buffer.

The same events also flow into the main `/api/v1/events` stream as
`type: "session_event"` with the payload JSON-encoded in the `detail` field, so
a single SSE connection can watch infra + agents together.

### Delete a session

```http
DELETE /api/v1/sessions/:id
```

- **Claude Code:** drops the session from the adapter's in-memory map and
  cancels any active turn. Returns `{ "ok": true }`.
- **Codex:** Codex persists threads in its own app-server and exposes no delete
  RPC. Returns **`501 Not Implemented`** with `code: "DELETE_NOT_SUPPORTED"`.
  Use the Codex CLI to forget threads.

This split is intentional — the daemon won't pretend to delete a session it
can't actually delete.

## Typed SDK

`spawntree-core` ships an `ApiClient` that mirrors the HTTP API with
Effect-validated responses.

```ts
import { createApiClient } from "spawntree-core";

const api = createApiClient({ baseUrl: "http://127.0.0.1:2222" });

// Create a session.
const { sessionId } = await api.createSession({
  provider: "claude-code",
  cwd: process.cwd(),
});

// Send a prompt.
await api.sendSessionMessage(sessionId, { content: "write hello world" });

// Stream events until the turn completes.
for await (const event of api.streamSessionEvents(sessionId)) {
  if (event.type === "message_delta") {
    process.stdout.write(event.text);
  }
  if (event.type === "turn_completed") break;
}

// Clean up.
await api.deleteSession(sessionId).catch((err) => {
  if (err.code === "DELETE_NOT_SUPPORTED") {
    console.log("codex sessions cannot be deleted from the daemon");
  }
});
```

## Provider resolution

`SessionManager` keeps one adapter instance per provider. Adapters are started
lazily on first use and shut down when the daemon exits.

`listSessions` and `findSession` call `adapter.isAvailable()` first and skip
adapters whose binary is missing — this keeps the daemon from spawning
`codex app-server` on a machine that only has Claude Code installed (or vice
versa).

A `sessionId → provider` cache is populated on `createSession` and on discovery.
Subsequent operations route via the cache, so a `sendMessage` on a known Claude
Code session never spawns a Codex subprocess.

## Permission policy

Each adapter wraps an ACP `Client` that auto-responds to permission requests.
The default policy is `allow_once` — appropriate for a single-user daemon on the
developer's own machine. Override via
`ClaudeCodeAdapterOptions.permissionPolicy`:

- `allow_once` — allow this one tool call
- `allow_always` — allow this tool for the session
- `reject_once` — reject this one
- `reject_always` — reject this tool for the session

**Fail-closed semantics.** If the user configured a `reject_*` policy but the
agent didn't offer that exact kind in its options, the adapter prefers any other
`reject_*` option and cancels the request if none exists. It will **never**
silently fall through to an `allow_*` option when the user asked to reject.

If you're embedding the daemon in a multi-user or remote host, replace the
default `Client` entirely via `ACPConnectionOptions.client` — the default
auto-responder is only appropriate for local single-user use.

## Custom providers

`SessionManager.registerAdapter(name, adapter)` accepts any type that implements
`ACPAdapter`. The HTTP schema (`SessionProvider`) is a `Schema.String` rather
than a closed literal, so custom provider names are accepted and rejected by the
manager (not the schema decoder) with a clear error if the name isn't
registered.

Minimum `ACPAdapter` shape:

```ts
interface ACPAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  discoverSessions(): Promise<DiscoveredSession[]>;
  createSession?(params): Promise<{ sessionId: string }>; // optional
  getSessionDetail(sessionId): Promise<SessionDetail>;
  sendMessage(sessionId, content): Promise<void>;
  interruptSession(sessionId): Promise<void>;
  resumeSession(sessionId): Promise<void>;
  deleteSession?(sessionId): Promise<void>; // optional; unsupported → 501
  onSessionEvent(handler): () => void;
  shutdown(): Promise<void>;
}
```

Throw `SessionBusyError` from `sendMessage` when the session has an in-flight
turn — the HTTP layer maps it to `409 Conflict`. Throw
`SessionDeleteUnsupportedError` from `deleteSession` (or omit the method
entirely) for providers that don't support deletion — the HTTP layer maps that
to `501 Not Implemented`.

## Sessions and envs

Today sessions are standalone: a session only knows its `cwd`. Future work
(tracked in the ROADMAP) attaches sessions to spawntree envs so creating a
session against a repo path auto-injects `DATABASE_URL`, `REDIS_URL`, and other
per-env variables into the agent's subprocess env — letting an agent "talk to"
the same isolated Postgres/Redis your running services are using.

Until that lands, pass an env-aware shell wrapper as the agent's `command` or
set `env` on the adapter options.
