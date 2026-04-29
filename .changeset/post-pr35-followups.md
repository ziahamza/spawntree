---
"spawntree-host": minor
"spawntree-daemon": minor
"spawntree-core": minor
---

Two follow-ups on top of `--host` / `--host-key` (#35):

**`spawntree-host`**: split `server.ts` into a `createApp({ store, host, port })`
factory plus a thin CLI entrypoint guarded by `import.meta.url ===
fileURLToPath(process.argv[1])`. `openStore` and the `Store` type are now
exported. The CLI behavior is unchanged (same env vars, same bin) but
embedders can now bind the handler to any `http.Server` without a child
process. The landing page at `GET /` now lists registered daemons (with
"config set" / "awaiting config" pills) alongside federation hosts.

**`spawntree-daemon`**: `GET /api/v1/storage` now returns a `hostSync` field
(union: `idle` | `fetching` | `synced` | `awaiting_config` | `error`, or
`null` in standalone mode) so the dashboard can paint host-binding state
without a separate endpoint. The infra page in the bundled web app
surfaces a "Storage" card and (when `--host` is in effect) a "Host
binding" card next to the existing PostgreSQL / Redis cards. Polished
across all four host-sync states + mobile after end-to-end QA: relative
time formatting, trimmed error messages, multi-line value layout fix,
status pill mapping (`Synced` / `Idle` / `Error` / `Fetching`).

**`spawntree-core`**: new `StorageStatusResponse` and `HostSyncState`
schemas, plus `apiClient.getStorageStatus()`.

Also: replaced the child-process integration test for the host server
with an in-process one that wires the new `createApp` factory to a
random-port `http.Server`. ~2× faster, no race on stderr, no dependency
on `dist/server.js` existing at test time. Bumped daemon's
`vitest.config` default timeout from 5s to 15s — pre-existing
parallel-load flakiness that grew worse as the suite passed 150 tests.
