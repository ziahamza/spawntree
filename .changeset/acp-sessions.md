---
"spawntree-core": minor
"spawntree-daemon": minor
"spawntree": patch
---

Add agent session API — drive Claude Code and Codex through the daemon as
first-class sessions.

- Normalized `ACPAdapter` layer in `spawntree-core` (Claude Code via native ACP,
  Codex via JSON-RPC app-server facade). Third-party providers register via
  `SessionManager.registerAdapter`.
- New HTTP API: `/api/v1/sessions` (list, create, detail, delete, send message,
  interrupt, per-session SSE events). Session events also mirror onto the main
  `/api/v1/events` stream as `type: "session_event"`.
- Typed SDK methods on `ApiClient`: `listSessions`, `createSession`,
  `getSession`, `deleteSession`, `sendSessionMessage`, `interruptSession`,
  `streamSessionEvents`.
- Typed errors with HTTP status translations: `SessionBusyError` → 409,
  `SessionDeleteUnsupportedError` → 501, `UnknownProviderError` /
  `ProviderCapabilityError` → 400.
- Fixes: permission policy fails closed on reject\_\*, concurrent sendMessage
  rejected with 409, deleteSession actually works (or returns 501), findSession
  cached to avoid spawning unrelated adapter subprocesses, totalTurns normalized
  across providers, per-session event history replay filtered by sessionId.
- Devin review fixes: JSON-RPC transport now emits `jsonrpc: "2.0"` on every
  request and notification (spec-required; Codex is permissive today but strict
  servers would reject). `SessionManager.createSession` now subscribes to
  adapter events BEFORE calling `adapter.createSession` so events emitted during
  startup aren't dropped. `listSessions` also subscribes to each adapter it
  successfully queries.
