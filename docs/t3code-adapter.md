# t3code adapter — design & roadmap

Status: **milestone 0 (WebSocket transport) landed. Milestones 1-5 parked.**

After shipping the transport we did a 30-minute smoke test — booted t3code's
full stack locally, inspected its bootstrap sequence, probed the wire
protocol. See [`t3code-smoke-findings.md`](./t3code-smoke-findings.md). Three
hard blockers surfaced:

1. All four `@t3tools/*` packages are `private: true` — nothing on npm.
2. Auth is HTTP-upgrade-layer (401 on raw WS connect). We'd have to stand up
   the full pairing flow to even get a handshake.
3. The web client blocks on `orchestration.subscribeShell` returning a
   snapshot before it'll render anything — every other stub we could fake
   runs downstream of that gate.

Net: ~4-5 weeks of focused work to get the t3code UI rendering against our
daemon, for a consumer that doesn't exist yet. Park it until someone
concrete asks.

The transport endpoint (`/api/v1/sessions/ws`) stays live regardless — it's
useful to our own dashboard and to any third-party SDK consumer. The rest
of this doc stays as a reference for the future if the balance changes.

## What this is

t3code ([github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code)) is a
polished web GUI for AI coding agents. MIT-licensed. Its web app talks to its
server over an Effect-RPC WebSocket using a contract we want to match.

Instead of rewriting t3code's UX from scratch, we run **two user-facing
front-ends over the same daemon**:

1. **spawntree's own dashboard** (ships today in PR #14) — minimal, tailored
   to the orchestrator.
2. **t3code's web app** pointed at spawntree-daemon — polished, feature-rich,
   maintained upstream.

The "adapter" is whatever lets #2 work: a WebSocket endpoint on our daemon
that speaks enough of t3code's protocol to make its client code happy.

## Protocol surface (from `~/repos/t3code/packages/contracts`)

### Categories

| Category | t3code methods | Our mapping | Effort |
|----------|----------------|-------------|--------|
| **Orchestration (core)** | `orchestration.subscribeThread`, `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `replayEvents`, `subscribeShell` | Maps to `SessionManager` + the event bus. This is the adapter's reason to exist. | **M** |
| **Projects** | `projects.{list,add,remove,searchEntries,writeFile}` | Maps to our `RepoCatalog` + `EnvManager`. Some mismatch in abstractions (t3code's "project" ≈ our "repo" + active env). | **L** |
| **Git** | `git.{pull,refreshStatus,runStackedAction,listBranches,createWorktree,removeWorktree,createBranch,checkout,init,resolvePullRequest,preparePullRequestThread}` | Partial overlap with our existing git surface. Much of t3code's richness (stacked branches, PR workflow) is out of scope for us. | **L** |
| **Filesystem** | `filesystem.browse` | Trivial. Stub with a minimal implementation. | **S** |
| **Shell / editor** | `shell.openInEditor` | Stub — delegate to OS `open`. | **S** |
| **Terminal** | `terminal.{open,write,resize,clear,restart,close}` | We don't run terminals. Return "not supported" to disable those UI paths. | **S** (to stub) |
| **Server meta** | `server.{getConfig,refreshProviders,upsertKeybinding,getSettings,updateSettings}` | Synthesize from `spawntree.yaml` + a small settings store. | **M** |
| **Auth** | Various auth methods | Local-only daemon today — return a stub "authenticated" session. | **S** |
| **Attachments** | Thread attachments | Stub for v1; wire into our event bus later. | **M** |

**Effort:** S = < 1 day, M = 2-4 days, L = > 1 week.

### Orchestration commands (the one we must implement fully)

From `packages/contracts/src/orchestration.ts`, `ClientOrchestrationCommand`
is a union of 16 command types:

| Command | Our mapping |
|---------|-------------|
| `thread.create` | `SessionManager.createSession` |
| `thread.delete` | `SessionManager.deleteSession` |
| `thread.archive` | *Not supported* — we don't archive, return error |
| `thread.unarchive` | *Not supported* |
| `thread.meta.update` | Store title in our session metadata |
| `thread.runtimeMode.set` | *Not supported* — our adapters don't expose runtime modes |
| `thread.interactionMode.set` | *Not supported* |
| `thread.turn.start` | `SessionManager.sendMessage` |
| `thread.turn.interrupt` | `SessionManager.interrupt` |
| `thread.approval.respond` | Needs approval plumbing (future work; we default to `allow_once` today) |
| `thread.userInput.respond` | Needs multi-turn input gathering (future) |
| `thread.checkpoint.revert` | *Not supported* — no checkpoints in spawntree |
| `thread.session.stop` | `SessionManager.deleteSession` (or a no-op if we want to keep for replay) |
| `project.{create,metaUpdate,delete}` | Out of scope for the adapter's first cut |

### Orchestration events (subscribeThread output)

t3code's `OrchestrationThreadStreamItem`:
- `kind: "snapshot"` — full thread state (metadata + all turns + tool calls)
- `kind: "event"` — delta (message chunks, turn started/completed, tool call updates)

Our `SessionEvent`:
- `turn_started`, `message_delta`, `tool_call_started`, `tool_call_completed`,
  `turn_completed`, `session_status_changed`

Mapping is straightforward — one-to-one with small shape differences. Write a
translator in `packages/daemon/src/t3code/events.ts`.

## Transport approach

t3code uses `RpcServer.toHttpEffectWebsocket` from `effect/unstable/rpc` —
Effect-RPC's own serialization + envelope on a WebSocket connection mounted
via `@effect/platform/HttpRouter`.

Our daemon uses Hono, not Effect's HttpRouter. Two options:

**Option A: Mount `@effect/platform/HttpRouter` on Hono.** Bridge the two
routing layers. Works but adds complexity to our server startup.

**Option B: Implement Effect-RPC's wire protocol manually over `ws`.** Study
the JSON envelope Effect-RPC sends, implement it by hand. Less type safety,
more surface area to maintain.

**Option C: Run a separate daemon process for the t3code endpoint.** A
sidecar that imports spawntree-core and serves the t3code protocol on a
different port. Clean separation but adds operational complexity.

Decision: **A, eventually.** For now, this PR ships **our own minimal
WebSocket protocol** (same `SessionEventPayload` types you already stream
via SSE) so we can start delivering live streaming UX. The t3code-specific
Effect-RPC translation gets built on top once we have a concrete user who
wants to point t3code at our daemon.

This is deliberate: the transport and the protocol are separable. Ship the
transport first (our own shape), layer t3code compatibility later.

## Roadmap

> **Status update (2026-04-18):** Milestone 0 landed. Milestones 1-5 are
> parked based on the smoke findings. Keeping them documented below as a
> reference if someone does show up with a concrete need.

### Milestone 0 (this PR): WebSocket transport + live streaming

- `/api/v1/sessions/ws` — WebSocket endpoint
- Client → server: `subscribe {sessionId}`, `send_message {sessionId, content}`, `interrupt {sessionId}`
- Server → client: streams `SessionEventPayload` for the subscribed session
- Uses plain JSON frames, no Effect-RPC yet
- Same message schemas as the existing SSE stream — so our own dashboard can optionally switch transport
- vitest integration test

### Milestone 1: t3code orchestration translator

- New file `packages/daemon/src/t3code/`:
  - `wire.ts` — Effect-RPC envelope encode/decode
  - `events.ts` — `SessionEvent` → `OrchestrationEvent` translator
  - `commands.ts` — `ClientOrchestrationCommand` → `SessionManager` dispatcher
  - `server.ts` — the WebSocket endpoint at `/api/v1/t3code/ws`
- Implement the 6 ORCHESTRATION_WS_METHODS, returning `NotImplemented` for out-of-scope commands
- Integration test: boot daemon, connect a raw Effect-RPC client, call `subscribeThread`, receive an event

### Milestone 2: Project + settings stubs

- `projects.list` → map from our repo catalog
- `projects.add/remove` → `addFolder` / `deleteClone`
- `server.getConfig` → synthesize from daemon info
- `server.{getSettings,updateSettings}` → a small `~/.spawntree/t3code-settings.json` store
- Enough to make t3code's boot sequence happy

### Milestone 3: Git + filesystem minimum

- `git.refreshStatus`, `git.listBranches`, `git.checkout` — existing catalog git helpers
- `filesystem.browse` — fs.readdir with filtering
- Everything else returns `NotSupported` with a clear error string

### Milestone 4: Stubs for the rest

- Terminal, attachments, auth, keybindings — return stable "not supported" responses
- Verified against t3code's actual client: does the UI gracefully degrade, or does it refuse to render?

### Milestone 5: Dogfood

- Run t3code's `apps/web` pointed at spawntree-daemon
- Document what works, what's missing, what t3code would need to change (if anything)

## Non-goals

- **Full t3code feature parity.** We're not building a complete coding IDE backend. If a t3code feature (stacked branches, terminal multiplexing, PR authoring) doesn't fit our scope, we stub it and move on.
- **Upstreaming to t3code.** Our adapter is a consumer of their protocol, not a fork.
- **Migrating our dashboard away from its own API.** Both UIs coexist. Our dashboard calls `/api/v1/*`; t3code calls `/api/v1/t3code/ws`. Shared underlying `SessionManager`.

## Open questions

1. **Does t3code's client actually boot against a partial server?** Need to test with real t3code pointed at a sparse implementation.
2. **Does t3code accept schema-level "extensions" for us to pass non-t3code data?** We may need to enrich some responses with spawntree-specific fields.
3. **Checkpointing.** t3code has a deep checkpoint/revert model. Spawntree doesn't. Figure out how to gracefully decline rather than confuse the UI.

## References

- t3code contracts: `~/repos/t3code/packages/contracts/src/orchestration.ts`
- t3code server wiring: `~/repos/t3code/apps/server/src/ws.ts`
- Our session manager: `packages/daemon/src/sessions/session-manager.ts`
- Our SSE stream: `packages/daemon/src/routes/sessions.ts:127`
