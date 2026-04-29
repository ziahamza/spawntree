---
"spawntree-core": minor
"spawntree-daemon": patch
---

Backfill git metadata from `working_directory` in the discovery loop, plus
re-export `detectGitMetadata` from `spawntree-core` for downstream daemons.

**Why**: some sessions reach `runDiscoveryPass` with NULL git metadata —
most commonly older Codex sessions whose `thread.gitInfo` wasn't captured
at session creation time. Without a `gitBranch` value those rows can't be
linked to a PR in the consuming UI, even though the session is clearly
tied to a particular branch on disk.

**Daemon**: when `discoverSessions` returns a row with any of `gitBranch /
gitHeadCommit / gitRemoteUrl` null, `SessionManager.runDiscoveryPass` now
runs `git rev-parse` against the session's `workingDirectory` and merges
in whatever's missing. Adapter-reported values always win; we only fill
nulls. A per-cwd cache prevents the daemon from re-spawning git on every
30-second discovery tick. Sessions whose `workingDirectory` no longer
exists (deleted worktree) skip the spawn entirely — the existing nulls
stay null, which is correct.

**Core**: re-exports `detectGitMetadata` and `GitMetadata` from
`spawntree-core`'s public entry point so daemons (and other downstream
consumers) can use the same git detection helper without depending on
internal `lib/git.ts` paths. The helper itself was added to core by #31.
