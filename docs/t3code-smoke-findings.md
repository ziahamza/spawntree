# t3code compatibility — smoke test findings

Date: 2026-04-18
Branch: `feat/t3code-ws-adapter`
t3code commit tested: HEAD as of ~2026-04-17 (cloned at `~/repos/t3code`)

## TL;DR

**t3code's web UI cannot be bundled into the spawntree dashboard via npm today.** Three hard reasons:

1. **All four t3code packages are `private: true` and unpublished** (`@t3tools/web`, `@t3tools/contracts`, `@t3tools/client-runtime`, `@t3tools/shared`). `npm view @t3tools/web` returns 404 for every package in the monorepo.
2. **Auth is enforced at the HTTP upgrade layer.** A fresh WebSocket connect to `ws://localhost:13773/ws` returns **HTTP 401** before any WebSocket frames are exchanged. A pairing flow (`bootstrapRemoteBearerSession`) turns a pairing token into a bearer session, which is then required on every WS connect. We'd need to stand up the full auth handshake to even get a handshake-level "hello".
3. **The web client's bootstrap gate blocks on `orchestration.subscribeShell` returning a snapshot.** Until that single RPC answers with a valid shell (projects + threads + updates), the UI stays in a bootstrap-pending state. No amount of faking other methods gets you past this.

Recommendation: **abandon the "run unmodified t3code web against our daemon" path.** Maintain our own dashboard (PR #14 landed), keep the WebSocket transport (PR #24 this branch), skip the t3code translation layer until there's a concrete user asking for it.

## What was checked

Ran t3code's full dev stack:
```
cd ~/repos/t3code
bun install                    # 1619 packages
bun run dev:server &           # t3 server on :13773, web build chain
bun run dev:web &              # t3 web on :5733
```

Both came up cleanly. `13773` logs: `Authentication required. Open T3 Code using the pairing URL. pairingUrl: http://localhost:5733/pair#token=WWZMHGN7PQL6`.

Then:
1. Opened `apps/web/src/rpc/protocol.ts` — WS endpoint is always `ws://host/ws` (pathname hard-coded, not configurable via public API).
2. Raw WS connect from Node with a valid client — **HTTP 401 on the upgrade**. Auth is gated at the HTTP handshake, not inside the WS protocol.
3. Read `packages/contracts/src/rpc.ts` — `WsRpcGroup` has **37 methods** across 7 categories.
4. Read `apps/web/src/environments/runtime/connection.ts` — bootstrap order confirmed.

## Protocol surface (37 RPC methods)

| Category | Methods | Verdict |
|----------|---------|---------|
| **Server meta** | `server.getConfig`, `server.refreshProviders`, `server.upsertKeybinding`, `server.getSettings`, `server.updateSettings`, `subscribeServerConfig`, `subscribeServerLifecycle`, `subscribeAuthAccess` | We'd need to synthesize most of these. `lifecycle` + `config` are hit on connect and the UI expects specific welcome shapes. |
| **Projects** | `projects.searchEntries`, `projects.writeFile` | No equivalent in our daemon. Shell snapshot also carries project metadata. |
| **Shell** | `shell.openInEditor` | Stub possible. |
| **Filesystem** | `filesystem.browse` | Stub possible. |
| **Git** | 11 methods (`gitPull`, `gitRefreshStatus`, `gitRunStackedAction`, `gitResolvePullRequest`, `gitPreparePullRequestThread`, `gitListBranches`, `gitCreateWorktree`, `gitRemoveWorktree`, `gitCreateBranch`, `gitCheckout`, `gitInit`, `subscribeGitStatus`) | Partial overlap with our env-manager git helpers. Much richer in t3code (stacked-branch workflow). |
| **Terminal** | 7 methods (`terminal.open/write/resize/clear/restart/close`, `subscribeTerminalEvents`) | We don't run terminals. UI expects event stream. |
| **Orchestration** | `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `replayEvents`, `subscribeShell`, `subscribeThread` | This is the bucket our `SessionManager` can actually fill. |

## The blocker: bootstrap gate

From `apps/web/src/environments/runtime/connection.ts`:

```typescript
const unsubShell = input.client.orchestration.subscribeShell(
  (item) => {
    if (item.kind === "snapshot") {
      input.syncShellSnapshot(item.snapshot, environmentId);
      bootstrapGate.resolve();   // ← only resolves on snapshot arrival
      return;
    }
    input.applyShellEvent(item, environmentId);
  },
  ...
);
```

`bootstrapGate.wait()` is what `ensureBootstrapped()` awaits. The gate resolves **only** when `subscribeShell` delivers a snapshot. Every piece of UI downstream of `ensureEnvironmentConnectionBootstrapped` is blocked on this.

A shell snapshot is:

```typescript
{
  snapshotSequence: NonNegativeInt,
  projects: OrchestrationProjectShell[],  // id, title, workspaceRoot, scripts, ...
  threads:  OrchestrationThreadShell[],   // id, projectId, title, runtimeMode, branch, worktreePath, session, ...
  updatedAt: IsoDateTime,
}
```

To produce one, we'd need to:
- Model our `envs` as t3code `projects` (reasonable — workspaceRoot = env's cwd)
- Model our sessions as t3code `threads` (reasonable — one thread per session)
- Fake the project script metadata (we don't have this concept)
- Decide `runtimeMode` and `interactionMode` per thread — our adapters don't expose these

That's a meaningful chunk of translation, not a drop-in.

## Extra signal: the provider names don't even match

t3code: `ProviderKind = "codex" | "claudeAgent"`
Ours: `SessionProvider = "codex" | "claude-code"`

Semantically identical, lexically different. One more translation row to maintain.

## Effort table for full t3code compatibility

Conservative estimates to make t3code's UI actually render against our daemon:

| Work | Effort |
|------|--------|
| Auth stub (bearer/pairing flow, no real security) | 2 days |
| Effect-RPC envelope on our Hono server | 3 days (needs `@effect/platform/HttpRouter` bridge) |
| Project/thread model translator (env → project, session → thread) | 3-4 days |
| `subscribeShell` snapshot + incremental events | 2 days |
| `server.getConfig` + lifecycle welcome | 1 day |
| `subscribeConfig` snapshot | 1 day |
| Orchestration commands mapped to SessionManager | 3-5 days |
| Terminal stubs (return empty snapshot, ignore commands) | 1 day |
| Git stubs (at least refreshStatus + listBranches) | 2 days |
| Auth access subscription stub | 1 day |
| Integration testing against the real t3code web | 3 days of iteration |
| **Total** | **~4-5 weeks of focused work** |

And that's before anyone asks us to handle:
- Checkpoint revert (not in our model)
- Stacked-branch git flows (not in our scope)
- Runtime/interaction mode changes (adapters don't expose)
- Attachments (not plumbed)
- Multi-environment federation from within t3code's UI (they have their own concept)

## Recommendation

**Stop work on the t3code translation layer. Keep the WebSocket transport.**

1. **Keep PR #24 as-is.** The `/api/v1/sessions/ws` endpoint is valuable on its own — our dashboard can migrate off SSE, external consumers have a bidi transport. The t3code-specific design doc stays as a reference for future work.

2. **Remove milestones 1-5 from the design doc** or mark them as "conditional on demand." No concrete user has asked to run t3code against spawntree; a 4-5 week translation project for a speculative consumer is hard to justify over near-term work (PR #15 storage follow-ups, polish on our dashboard sessions UI, per-env integration from the design-review gaps).

3. **If someone does show up wanting t3code compat:** the right answer is likely to fork t3code's web under a `@spawntree/t3code-web` npm package, patch the `environmentApi` layer (one file) to speak our wire format, and publish that. Still a month of work, but the cost lands once rather than dripping into core daemon complexity.

4. **Alternative that's cheaper and as useful:** our existing SDK (`spawntree-core`'s `ApiClient` + the new `/api/v1/sessions/ws`) is already good enough for any third party to build a t3code-style UI against if they want. We don't need to be the ones who build it.

## What actually delivers user value next

- **Milestone 0 of the old doc (this PR)** — ship it. Merged once Devin's final pass clears.
- **Per-env session context** — the `envId` field on sessions so agents run against isolated DB/Redis envs (ROADMAP item, real user value for gitenv).
- **CLI session commands** — `spawntree session list/start/send/kill`.
- **Richer dashboard session view** — markdown rendering, approval dialogs, tool-call expanders (v2 of what we shipped in PR #14).

Each of those beats t3code integration on value-per-hour by a wide margin.

## Updated t3code-adapter.md

I'm updating `docs/t3code-adapter.md` in the same commit to reflect this finding — marking milestones 1-5 as **park** with a pointer to this smoke report. The WebSocket transport (milestone 0) stays as-is because it's valuable regardless.
