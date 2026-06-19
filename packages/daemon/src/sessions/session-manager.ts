import { existsSync } from "node:fs";
import type {
  ACPAdapter,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPSessionDetail,
  AdoptedSession,
  CatalogDb,
  DiscoveredSession,
  GitMetadata,
  SessionEvent,
  SessionInfo,
  SessionToolCallData,
  ToolCallApprovalOption,
} from "spawntree-core";
import {
  ClaudeCodeAdapter,
  CodexACPAdapter,
  detectGitMetadata,
  ProviderCapabilityError,
  schema as catalogSchema,
  SessionDeleteUnsupportedError,
  UnknownProviderError,
} from "spawntree-core";
import type { NewSessionSandbox } from "spawntree-core";
import { drizzle } from "drizzle-orm/libsql";
import type { DomainEvents } from "../events/domain-events.ts";
import { applyCatalogSchema } from "../catalog/queries.ts";
import type { SandboxManager } from "../sandbox/manager.ts";
import type { StorageManager } from "../storage/manager.ts";
import {
  abortOrphanedToolCallsOnRestart,
  deletePersistedSession,
  getPersistedSession,
  hydrateTurnContent,
  listPersistedSessionIdsByProvider,
  listPersistedSessions,
  loadAdoptableSession,
  persistSessionEvent,
  replaceSessionTurns,
  upsertSession,
} from "./persistence.ts";
import {
  listDiscoverableClaudeSessions,
  parseClaudeJsonl,
  resolveClaudeJsonlPath,
} from "./claude-jsonl.ts";

/**
 * Cap on how many sessions are eagerly adopted into the live adapter on boot.
 * Adopting every session retains its full transcript in memory (a large
 * history OOMs the daemon — `invalid array length` at ~2.4GB on a 1430-session
 * box) and the synchronous parse/import blocks the single event loop, which
 * aborts the Turso sync fetch and starves the host heartbeat. Sessions past
 * the cap stay in the catalog — still listed via `listSessions()` and readable
 * via `getPersistedSessionDetail()` (both query the catalog, not the adapter
 * map) — and are re-adopted lazily on access. Override with
 * `SPAWNTREE_BOOT_IMPORT_MAX`.
 */
function bootImportMax(): number {
  const raw = Number.parseInt(process.env["SPAWNTREE_BOOT_IMPORT_MAX"] ?? "", 10);
  // Default 200: ~200 retained transcripts stays well under the default V8 heap
  // (~2GB). 500 reached ~1.9GB on a 1430-session box, where the GC pressure
  // stalled the loop and aborted the sync. Raise it when the daemon runs with
  // more --max-old-space-size headroom.
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

/** How many boot-import iterations to run before yielding to the event loop. */
const BOOT_IMPORT_YIELD_EVERY = 25;

/** Yield control so a long boot import doesn't starve the HTTP server, the
 *  Turso background sync, or the host heartbeat. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Pending approval entry held while a tool call awaits user response. */
interface PendingApproval {
  resolver: (response: ACPRequestPermissionResponse) => void;
  options: ToolCallApprovalOption[];
  sessionId: string;
}

/**
 * Manages the lifecycle of ACP adapters and routes session operations to
 * the correct provider. Publishes normalized SessionEvents into the daemon's
 * DomainEvents bus so the SSE stream carries real-time agent updates.
 *
 * One adapter instance per provider — they are started lazily on first use
 * and shut down when the daemon shuts down.
 */
export class SessionManager {
  private readonly adapters = new Map<string, ACPAdapter>();
  private readonly events: DomainEvents;
  /**
   * Per-provider event unsubscribe functions. Map keyed by provider name
   * so `registerAdapter` can find the old subscription when replacing an
   * adapter and tear it down cleanly. An `Array<() => void>` wouldn't
   * let us identify which unsubscriber belonged to which provider.
   */
  private readonly unsubscribers = new Map<string, () => void>();
  /**
   * sessionId → provider name cache. Populated on createSession and
   * opportunistically during discoverSessions so we avoid iterating every
   * adapter (which would spawn every adapter's subprocess) on each call.
   */
  private readonly sessionIndex = new Map<string, string>();
  private readonly subscribedProviders = new Set<string>();

  /**
   * When present, session events are mirrored into the catalog DB so
   * sessions survive daemon restart, ride along with S3 snapshot sync when
   * enabled, and are queryable by external Drizzle clients.
   *
   * Null when the manager is built without a StorageManager (older test
   * code paths) — in that case sessions are in-memory only.
   */
  private readonly catalog: CatalogDb | null;
  private readonly storage: StorageManager | null;
  /** When present, sessions can be created inside provider-managed sandboxes. */
  private readonly sandboxManager: SandboxManager | null;
  /**
   * Per-session promise chain so adapter events land in the catalog in
   * the order they were emitted. Without this, `turn_completed` may
   * race the `turn_started` INSERT and run its UPDATE against 0 rows.
   */
  private readonly persistQueues = new Map<string, Promise<unknown>>();
  /**
   * Tool calls awaiting human approval — keyed by `toolCallId`. The value
   * is the Promise resolver fed back to the ACP `request_permission` RPC
   * once the user clicks Allow/Deny in the Studio. If the daemon shuts
   * down with entries here, the agent is left waiting forever, so we
   * also clear the corresponding rows on startup (see `start()`).
   */
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  /**
   * In-memory snapshot of the most recent `discoverSessions()` pass, keyed
   * by `${provider}:${sourceId}`. Populated by `runDiscoveryPass()` and
   * served by `listSessions()` so the HTTP route doesn't spawn adapter
   * subprocesses on every request (was a 2.5-3s tax per call before).
   */
  private discoveryCache: Array<DiscoveredSession & { provider: string }> = [];
  private discoveryCacheAt = 0;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryStopped = false;
  /**
   * Set the moment `startDiscoveryLoop` is called, BEFORE the first
   * `tick()` resolves. Without this flag, the idempotency guard would
   * still let a second call slip through during the (potentially several
   * seconds) window where `discoveryTimer` is still null because the
   * setTimeout assignment only happens after `runDiscoveryPass` finishes.
   */
  private discoveryLoopStarted = false;
  /**
   * Cache of `cwd → GitMetadata` for sessions whose adapter didn't report
   * git metadata. Populated lazily by `backfillGitMetadata()`. Without
   * this cache the daemon would `git rev-parse` the same worktree on
   * every 30-second discovery tick — for a busy machine that's hundreds
   * of subprocess spawns per minute.
   *
   * Cached values are kept for the lifetime of the daemon process. If a
   * worktree is deleted and recreated at the same path with a different
   * branch, the cached value goes stale until the next daemon restart;
   * acceptable trade-off vs. re-detecting every tick.
   */
  private readonly gitMetadataCache = new Map<string, GitMetadata>();

  constructor(
    events: DomainEvents,
    options: { storage?: StorageManager; sandboxManager?: SandboxManager } = {},
  ) {
    this.events = events;
    this.storage = options.storage ?? null;
    this.sandboxManager = options.sandboxManager ?? null;
    this.catalog = options.storage
      ? drizzle(options.storage.client, { schema: catalogSchema })
      : null;

    // Register built-in adapters. Additional adapters can be added via
    // `registerAdapter()` before the manager is used. When a SandboxManager
    // is present, wire the Claude adapter so `{ sandboxId }` sessions exec
    // their agent inside the container instead of on the host.
    const sandboxManager = options.sandboxManager;
    this.adapters.set(
      "claude-code",
      new ClaudeCodeAdapter({
        permissionHandler: (params) => this.handlePermissionRequest(params),
        ...(sandboxManager
          ? { sandboxSpawnerProvider: (id: string) => sandboxManager.spawnerFor(id) }
          : {}),
      }),
    );
    this.adapters.set("codex", new CodexACPAdapter());
  }

  /**
   * Bootstrap the catalog schema for the session tables. Called once at
   * daemon boot from `server-main.ts` after the StorageManager has opened
   * its primary. Safe to skip (and is in tests) if the manager was built
   * without a StorageManager — `applyCatalogSchema` is idempotent so
   * double-bootstrap from the DaemonService layer is a no-op.
   */
  async start(): Promise<void> {
    if (this.storage) {
      await applyCatalogSchema(this.storage.client);
      // Any tool call left non-terminal (awaiting_approval / pending /
      // in_progress) is orphaned — the agent driving it died with the previous
      // daemon process. Mark them error so the UI doesn't show forever-spinning
      // "running" rows (and so the session stops looking live, which drove a
      // refetch loop in the chat panel).
      if (this.catalog) {
        await abortOrphanedToolCallsOnRestart(this.catalog).catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] failed to clear orphaned tool calls on startup: ${String(err)}\n`,
          );
        });
        // Re-introduce persisted Claude Code sessions into the adapter's
        // in-memory map. Without this, the adapter starts with an empty
        // map and any subsequent getSessionDetail / sendMessage / resume
        // for a session that survived restart fails with "Unknown session".
        // Codex doesn't need this — its subprocess persists threads itself
        // and re-discovers them via thread/list.
        await this.hydrateClaudeAdapterFromCatalog().catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] failed to hydrate Claude sessions from catalog: ${String(err)}\n`,
          );
        });
        // After the catalog-driven hydration, walk `~/.claude/projects/`
        // and import every Claude CLI session that isn't already in the
        // catalog (sessions created via the Claude Code IDE or a direct
        // `claude` invocation never went through `POST /sessions` on the
        // daemon, so the catalog has no row for them). Imported rows
        // expose them to the Studio's per-PR session filter alongside
        // sessions the daemon created itself.
        await this.discoverFromClaudeProjects().catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] failed to discover Claude sessions on disk: ${String(err)}\n`,
          );
        });
      }
    }
  }

  /**
   * Adopt every persisted Claude Code session into the adapter's in-memory
   * tracking so the post-restart catalog and the live adapter agree on
   * which sessions exist. Hydration is cheap — only touches the in-memory
   * `Map`; the ACP subprocess is told about each session lazily on next
   * interaction (see `ClaudeCodeAdapter.ensureSubprocessHasSession`).
   *
   * Failures on individual sessions are logged and skipped so one corrupt
   * row doesn't abort daemon boot.
   */
  private async hydrateClaudeAdapterFromCatalog(): Promise<void> {
    if (!this.catalog) return;
    const adapter = this.adapters.get("claude-code");
    if (!adapter || !(adapter instanceof ClaudeCodeAdapter)) return;

    const ids = await listPersistedSessionIdsByProvider(this.catalog, "claude-code");
    if (ids.length === 0) return;

    // Bound boot adoption + yield between sessions so a large history doesn't
    // OOM or block the loop. `ids` is ordered most-recent-first, so the tail
    // stays catalog-only until accessed (see `bootImportMax`).
    const maxAdopt = bootImportMax();
    const adoptIds = ids.length > maxAdopt ? ids.slice(0, maxAdopt) : ids;
    if (adoptIds.length < ids.length) {
      process.stderr.write(
        `[spawntree-daemon] adopting the ${adoptIds.length} most-recent of ${ids.length} catalog sessions on boot (SPAWNTREE_BOOT_IMPORT_MAX=${maxAdopt}); the rest stay catalog-only until accessed\n`,
      );
    }

    let adopted = 0;
    let backfilled = 0;
    for (const [adoptIndex, sessionId] of adoptIds.entries()) {
      try {
        const snapshot = await loadAdoptableSession(this.catalog, sessionId);
        if (!snapshot) continue;

        // The catalog stores turn skeletons (`content: []`) — final content
        // historically came from the in-memory adapter via `hydrateTurnContent`,
        // which doesn't run for sessions that ended with a previous daemon
        // process. The Claude CLI itself wrote the full transcript to disk;
        // re-parse it so adopted sessions render their actual conversation
        // history in the Studio instead of empty bubbles.
        const jsonlPath = resolveClaudeJsonlPath(snapshot.cwd, sessionId);
        if (jsonlPath) {
          const parsed = parseClaudeJsonl(jsonlPath, sessionId);
          // Skip the destructive replace when the parser hit a corrupt
          // line — a truncated transcript would otherwise overwrite valid
          // persisted turns with only the parsed prefix, losing history
          // permanently. Adopt the parsed turns in-memory only and leave
          // the catalog rows alone for now; the next clean parse can
          // hydrate.
          if (parsed.turns.length > 0 && !parsed.partialParse) {
            snapshot.turns = parsed.turns;
            // Derive title from the first user message when the catalog
            // doesn't already have one. Without this, every adopted
            // session shows "Untitled" forever — the adapter never
            // generates a title server-side and there's no UX to set
            // one. The .jsonl already has the user's own first message,
            // which is the natural label.
            if (parsed.title && !snapshot.title) {
              snapshot.title = parsed.title;
            }
            // Repair `startedAt` / `updatedAt` from real turn timestamps
            // when available. The previous `upsertSession` implementation
            // stamped `now()` on every discovery tick, so legacy rows
            // carry "boot time" timestamps that lie about activity.
            // Replacing them with the .jsonl's first/last turn times
            // makes the Threads tab show the truth (sessions days apart,
            // not all 26 simultaneous).
            if (parsed.startedAt) snapshot.startedAt = parsed.startedAt;
            if (parsed.lastActivityAt) snapshot.updatedAt = parsed.lastActivityAt;
            // Backfill the catalog so external Drizzle clients (Studio
            // offline, Turso replicas) also see the real content.
            // `replaceSessionTurns` preserves existing turn ids by index
            // so `session_tool_calls.turn_id` references stay attached.
            if (this.catalog) {
              let replaceFailed = false;
              try {
                await replaceSessionTurns(this.catalog, sessionId, parsed.turns);
              } catch (err) {
                replaceFailed = true;
                process.stderr.write(
                  `[spawntree-daemon] backfill failed for session ${sessionId}: ${String(err)}\n`,
                );
              }
              // Skip the metadata upsert when the turn replace failed:
              // otherwise `sessions.total_turns` / `started_at` would
              // claim a successful hydration that didn't happen, and
              // downstream readers would see counts that don't match
              // the `session_turns` rows.
              if (!replaceFailed) {
                // Always upsert when we hydrated turns, not only when a
                // title was derived — the row may need its `started_at` /
                // `updated_at` reset even when title resolution failed
                // (e.g., conversation only has tool calls and no text).
                // `overwriteMetrics` is on so existing rows get the
                // corrected `total_turns` / `started_at`; without it the
                // upsert's normal conflict path skips those fields to
                // protect the live counters maintained by `bumpTotalTurns`.
                // `totalTurns` counts user messages only — same convention
                // `ClaudeCodeAdapter.discoverSessions` reports, so a
                // freshly-hydrated row matches what the live adapter
                // would say. Without this filter the parsed array
                // (which interleaves user + assistant rows) inflates
                // the catalog count by ~2x and the Studio's session
                // list drifts from live state.
                await upsertSession(this.catalog, {
                  sessionId,
                  provider: "claude-code",
                  status: snapshot.status,
                  workingDirectory: snapshot.cwd,
                  title: snapshot.title,
                  gitBranch: snapshot.gitBranch,
                  gitHeadCommit: snapshot.gitHeadCommit,
                  gitRemoteUrl: snapshot.gitRemoteUrl,
                  totalTurns: parsed.turns.filter((t) => t.role === "user").length,
                  startedAt: snapshot.startedAt,
                  updatedAt: snapshot.updatedAt,
                  overwriteMetrics: true,
                }).catch((err) => {
                  process.stderr.write(
                    `[spawntree-daemon] hydration upsert failed for session ${sessionId}: ${String(err)}\n`,
                  );
                });
                backfilled += 1;
              }
            }
          } else if (parsed.partialParse) {
            process.stderr.write(
              `[spawntree-daemon] skipping backfill for session ${sessionId}: transcript has corrupt lines\n`,
            );
          }
        }

        adapter.adoptSession(snapshot);
        this.sessionIndex.set(sessionId, "claude-code");
        adopted += 1;
      } catch (err) {
        process.stderr.write(
          `[spawntree-daemon] adopt failed for session ${sessionId}: ${String(err)}\n`,
        );
      }
      if ((adoptIndex + 1) % BOOT_IMPORT_YIELD_EVERY === 0) await yieldToEventLoop();
    }
    process.stderr.write(
      `[spawntree-daemon] adopted ${adopted}/${adoptIds.length} Claude Code sessions from catalog (backfilled ${backfilled} from .jsonl)\n`,
    );
  }

  /**
   * Walk `~/.claude/projects/` and import every Claude CLI session that
   * isn't already in the catalog. This covers sessions the user ran via
   * the Claude Code IDE or a direct `claude` CLI invocation — they never
   * went through `POST /sessions` on the daemon, so the standard
   * catalog-driven hydration above couldn't see them.
   *
   * Imported sessions get the same in-memory adoption treatment as
   * catalog-restored ones (`adapter.adoptSession`, `loadedInSubprocess:
   * false`), so the first interaction triggers a lazy `loadSession`
   * exactly like a daemon-created session. If the agent can't actually
   * resume that session — likely when the JSONL came from a different
   * Claude invocation channel — the adapter records `resumeFailed` and
   * the Studio surfaces a read-only banner instead of throwing.
   *
   * Git metadata is captured at import time via `detectGitMetadata(cwd)`,
   * which reads the cwd's CURRENT branch/head. That means a session
   * recorded yesterday on `main` shows up under the branch the cwd has
   * checked out today — accepted compromise; the JSONL doesn't carry
   * the original branch, and matching via `git reflog` would be
   * heuristic at best.
   */
  private async discoverFromClaudeProjects(): Promise<void> {
    if (!this.catalog) return;
    const adapter = this.adapters.get("claude-code");
    if (!adapter || !(adapter instanceof ClaudeCodeAdapter)) return;

    const candidates = listDiscoverableClaudeSessions();
    if (candidates.length === 0) return;

    // Bound the on-disk import + yield, same rationale as catalog hydration.
    // Already-known sessions are skipped below, so on a re-boot this mostly
    // imports only new ones; the cap caps the first-boot burst on a machine
    // with a large ~/.claude/projects history.
    const maxImport = bootImportMax();
    const importCandidates =
      candidates.length > maxImport ? candidates.slice(0, maxImport) : candidates;
    if (importCandidates.length < candidates.length) {
      process.stderr.write(
        `[spawntree-daemon] importing ${importCandidates.length} of ${candidates.length} on-disk Claude sessions this pass (SPAWNTREE_BOOT_IMPORT_MAX=${maxImport})\n`,
      );
    }

    // Cache git metadata per cwd — every session inside the same
    // `~/.claude/projects/<encoded-cwd>/` folder shares the same cwd, so
    // we avoid spawning N git invocations for N sessions.
    const gitByCwd = new Map<string, GitMetadata>();
    let imported = 0;
    let skipped = 0;

    for (const [importIndex, candidate] of importCandidates.entries()) {
      try {
        const existing = await getPersistedSession(this.catalog, candidate.sessionId);
        if (existing) {
          skipped += 1;
          continue;
        }

        const parsed = parseClaudeJsonl(candidate.jsonlPath, candidate.sessionId);
        if (parsed.turns.length === 0) {
          // Empty transcript (or unreadable) — nothing useful to import.
          skipped += 1;
          continue;
        }

        if (parsed.partialParse) {
          // Defer the entire import until the transcript parses cleanly.
          // Previously the session row was upserted before this check
          // and turn backfill was skipped, leaving an orphan row with
          // metadata but zero turns. On the next boot, getPersistedSession
          // would return the orphan and discovery would skip the session
          // entirely, so transcript history could disappear permanently
          // for any session with a corrupt JSONL line. Skipping the
          // whole import here lets the next discovery pass retry once
          // the agent finishes writing.
          process.stderr.write(
            `[spawntree-daemon] discovered session ${candidate.sessionId} but transcript has corrupt lines; deferring import until next discovery\n`,
          );
          skipped += 1;
          continue;
        }

        let git = gitByCwd.get(candidate.cwd);
        if (!git) {
          git = detectGitMetadata(candidate.cwd);
          gitByCwd.set(candidate.cwd, git);
        }

        // Build the snapshot in the same shape `loadAdoptableSession`
        // produces, so the adapter doesn't care that this session
        // didn't pass through the normal catalog flow. The explicit
        // `AdoptedSession` annotation pins `toolCalls` to the mutable
        // variant the adapter expects — without it the inferred type
        // resolves through `spawntree-core`'s readonly Effect Schema
        // variant and `adoptSession()` rejects the call.
        const startedAt = parsed.startedAt ?? new Date().toISOString();
        const updatedAt = parsed.lastActivityAt ?? startedAt;
        const snapshot: AdoptedSession = {
          sessionId: candidate.sessionId,
          cwd: candidate.cwd,
          status: "idle",
          title: parsed.title,
          turns: parsed.turns,
          toolCalls: [],
          startedAt,
          updatedAt,
          gitBranch: git.branch,
          gitHeadCommit: git.headCommit,
          gitRemoteUrl: git.remoteUrl,
        };

        await upsertSession(this.catalog, {
          sessionId: snapshot.sessionId,
          provider: "claude-code",
          status: snapshot.status,
          workingDirectory: snapshot.cwd,
          title: snapshot.title,
          gitBranch: snapshot.gitBranch,
          gitHeadCommit: snapshot.gitHeadCommit,
          gitRemoteUrl: snapshot.gitRemoteUrl,
          // User-turn count keeps catalog rows aligned with what
          // `ClaudeCodeAdapter.discoverSessions` reports for live
          // sessions. Inserting `parsed.turns.length` instead would
          // double-count because the parser emits user + assistant
          // rows.
          totalTurns: parsed.turns.filter((t) => t.role === "user").length,
          startedAt: snapshot.startedAt,
          updatedAt: snapshot.updatedAt,
          overwriteMetrics: true,
        });

        await replaceSessionTurns(this.catalog, snapshot.sessionId, parsed.turns);

        adapter.adoptSession(snapshot);
        this.sessionIndex.set(snapshot.sessionId, "claude-code");
        imported += 1;
      } catch (err) {
        process.stderr.write(
          `[spawntree-daemon] discover failed for session ${candidate.sessionId}: ${String(err)}\n`,
        );
      }
      if ((importIndex + 1) % BOOT_IMPORT_YIELD_EVERY === 0) await yieldToEventLoop();
    }

    process.stderr.write(
      `[spawntree-daemon] discovered ${imported} new Claude sessions on disk (${skipped} already known or empty)\n`,
    );
  }

  /**
   * ACP permission handler — invoked by the Claude Code adapter when the
   * agent requests permission to run a tool. Persists the tool call as
   * `awaiting_approval`, broadcasts the event over SSE so the Studio can
   * render Allow/Deny buttons, and pends a Promise. The Promise resolves
   * when `respondToToolCall()` is called (typically from the HTTP route
   * `POST /sessions/:id/tool-calls/:toolCallId/respond`).
   *
   * If the same toolCallId already has a pending entry, the previous
   * resolver is cancelled (resolved with `{ outcome: "cancelled" }`) so
   * the older Promise unblocks instead of leaking.
   */
  private handlePermissionRequest(
    params: ACPRequestPermissionRequest,
  ): Promise<ACPRequestPermissionResponse> {
    const toolCallId = params.toolCall.toolCallId;
    const sessionId = params.sessionId;
    process.stderr.write(
      `[spawntree-daemon] permission requested: session=${sessionId} toolCall=${toolCallId} title=${params.toolCall.title ?? "?"} kind=${params.toolCall.kind ?? "?"} options=${params.options.map((o) => o.kind).join(",")}\n`,
    );
    const options: ToolCallApprovalOption[] = params.options.map(
      (o: ACPRequestPermissionRequest["options"][number]) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind as ToolCallApprovalOption["kind"],
      }),
    );
    const toolCall = approvalToolCallFromRequest(params, options);

    // Publish synthetic SessionEvent so the same SSE pipeline + persistence
    // queue handle it (status row in DB ends up "awaiting_approval"). We
    // don't go through the adapter's own onSessionEvent emit because the
    // adapter itself doesn't track this transition — the daemon owns it.
    const event: SessionEvent = {
      type: "tool_call_awaiting_approval",
      sessionId,
      toolCall,
    };
    this.events.publishSessionEvent(event, "claude-code");
    if (this.catalog) {
      void this.enqueuePersist(sessionId, () =>
        persistSessionEvent(this.catalog!, event).catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] persist awaiting_approval failed: ${String(err)}\n`,
          );
        }),
      );
    }

    return new Promise<ACPRequestPermissionResponse>((resolve) => {
      const previous = this.pendingApprovals.get(toolCallId);
      if (previous) {
        // Stale resolver from an earlier (re-tried?) request — cancel it
        // so its Promise unblocks instead of leaking.
        previous.resolver({ outcome: { outcome: "cancelled" } });
      }
      this.pendingApprovals.set(toolCallId, { resolver: resolve, options, sessionId });
    });
  }

  /**
   * Resolve a pending approval prompt with the user's choice. Throws if
   * the toolCallId has no pending entry — the request either already
   * resolved (race), the daemon restarted, or the agent never asked.
   */
  async respondToToolCall(
    sessionId: string,
    toolCallId: string,
    response: ACPRequestPermissionResponse,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(toolCallId);
    if (!pending) {
      throw new Error(`No pending approval for tool call ${toolCallId}`);
    }
    if (pending.sessionId !== sessionId) {
      throw new Error(`Tool call ${toolCallId} does not belong to session ${sessionId}`);
    }
    this.pendingApprovals.delete(toolCallId);
    pending.resolver(response);
  }

  /**
   * Patch any tool calls in a SessionDetail with their pending-approval
   * state. The adapter's in-memory tracking does not know that a
   * permission request is in flight — the daemon owns that — so without
   * this overlay a fresh `GET /sessions/:id` would show the tool as
   * `in_progress` instead of `awaiting_approval`.
   */
  private patchPendingApprovals(detail: ACPSessionDetail): ACPSessionDetail {
    if (this.pendingApprovals.size === 0) return detail;
    return {
      ...detail,
      toolCalls: detail.toolCalls.map((tc) => {
        const pending = this.pendingApprovals.get(tc.id);
        if (!pending) return tc;
        return {
          ...tc,
          status: "awaiting_approval" as const,
          approvalOptions: pending.options,
        };
      }),
    };
  }

  /**
   * Register a custom adapter (or override a built-in one).
   *
   * Replacing an already-registered adapter is safe: we unsubscribe the
   * old instance's event handler, shut down its subprocess (best-effort,
   * in the background so callers don't block on a slow teardown), and
   * drop any sessionIndex entries that pointed at it. The new adapter
   * starts with a clean slate.
   *
   * Returns synchronously; if the old adapter's shutdown fails, the
   * error is swallowed — there's no caller waiting for it.
   */
  registerAdapter(provider: string, adapter: ACPAdapter): void {
    const previous = this.adapters.get(provider);
    if (previous && previous !== adapter) {
      // Unsubscribe the old instance's event handler so it can be GC'd.
      const unsub = this.unsubscribers.get(provider);
      if (unsub) {
        try {
          unsub();
        } catch {
          // best-effort
        }
        this.unsubscribers.delete(provider);
      }
      this.subscribedProviders.delete(provider);
      // Drop sessionIndex entries that belonged to the replaced adapter
      // — otherwise cached routing would still send operations to the
      // dead handle.
      for (const [sessionId, providerName] of this.sessionIndex) {
        if (providerName === provider) this.sessionIndex.delete(sessionId);
      }
      // Shut down the old subprocess in the background so we don't leak it.
      void previous.shutdown().catch(() => {});
    } else {
      // Brand-new provider name — still clear any stale subscription state
      // (defensive: registerAdapter called before any adapter was wired up).
      this.subscribedProviders.delete(provider);
    }
    this.adapters.set(provider, adapter);
  }

  /**
   * Returns the list of provider names currently registered. Useful for
   * introspection / admin surfaces. Does not start any subprocesses.
   */
  registeredProviders(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Returns which providers have their binary available on this machine.
   */
  async availableProviders(): Promise<string[]> {
    const results: string[] = [];
    for (const [name, adapter] of this.adapters) {
      if (await adapter.isAvailable()) {
        results.push(name);
      }
    }
    return results;
  }

  /**
   * List all known sessions across all providers.
   *
   * Serves from the discovery cache when fresh (default: ≤30s old). The
   * cache is populated by the background discovery loop started in
   * `startDiscoveryLoop()`. Falls through to a synchronous discovery pass
   * when the cache is stale or empty so first-call latency is bounded.
   *
   * Also populates `sessionIndex` and subscribes to each successfully-
   * queried adapter so live events flow into the domain events bus.
   */
  async listSessions(): Promise<Array<DiscoveredSession & { provider: string }>> {
    const cacheAgeMs = Date.now() - this.discoveryCacheAt;
    if (this.discoveryCacheAt > 0 && cacheAgeMs < 30_000) {
      // Fresh cache — return as-is, no adapter subprocesses needed.
      return [...this.discoveryCache];
    }

    // Stale or empty cache: do a live pass and seed the cache.
    return this.runDiscoveryPass();
  }

  /**
   * Force a fresh `discoverSessions()` call across every available adapter,
   * mirror results into the catalog, and update the in-memory cache.
   *
   * This is also the body of the periodic discovery loop. Designed to be
   * cheap-on-failure: a crashed adapter or a network blip skips that
   * provider for this pass and tries again next tick.
   */
  async runDiscoveryPass(): Promise<Array<DiscoveredSession & { provider: string }>> {
    const all: Array<DiscoveredSession & { provider: string }> = [];
    for (const [provider, adapter] of this.adapters) {
      // Skip adapters whose binary is missing — otherwise discoverSessions
      // would spawn a subprocess that immediately fails, just to return 0
      // sessions. That's wasteful and noisy.
      try {
        if (!(await adapter.isAvailable())) continue;
      } catch {
        continue;
      }

      try {
        const sessions = await adapter.discoverSessions();
        for (const s of sessions) {
          all.push({ ...s, provider });
          this.sessionIndex.set(s.sourceId, provider);
        }

        // Mirror discovered sessions into the catalog so external Drizzle
        // readers (Studio via the catalog HTTP endpoint, Turso/S3 sync
        // targets, third-party tools) see the same set
        // of sessions the daemon sees over ACP. Without this hop, sessions
        // started outside the daemon (e.g. `codex exec ...` from a terminal)
        // are invisible to anything that queries `SELECT * FROM sessions`.
        //
        // `backfillGitMetadata` runs `git rev-parse` against the session's
        // working_directory whenever the adapter reported any of branch /
        // headCommit / remoteUrl as null. Some Codex sessions are missing
        // `gitInfo` from `thread.gitInfo` for legacy reasons, and without
        // a branch we can't link those sessions to the right PR in the UI.
        // Detection is cached per-cwd so subsequent ticks are free.
        if (this.catalog) {
          for (const s of sessions) {
            const git = this.backfillGitMetadata(s);
            await upsertSession(this.catalog, {
              sessionId: s.sourceId,
              provider,
              status: s.status,
              workingDirectory: s.workingDirectory,
              title: s.title,
              gitBranch: git.branch,
              gitHeadCommit: git.headCommit,
              gitRemoteUrl: git.remoteUrl,
              totalTurns: s.totalTurns,
              startedAt: s.startedAt,
              // Preserve the adapter's real `updatedAt` rather than
              // stamping `now()` on every discovery tick. Without this
              // the catalog column collapses to "boot time" right after
              // a daemon restart and is useless for sorting by recency.
              updatedAt: s.updatedAt,
            }).catch((err) => {
              process.stderr.write(
                `[spawntree-daemon] discovery upsert failed for ${s.sourceId}: ${String(err)}\n`,
              );
            });
          }
        }

        // Idempotent — only wires up the handler once per provider.
        this.subscribeToAdapter(provider, adapter);
      } catch {
        // Provider unreachable (subprocess crashed, etc.) — skip silently.
      }
    }
    this.discoveryCache = all;
    this.discoveryCacheAt = Date.now();
    return all;
  }

  /**
   * Start a background discovery loop. Each tick runs a full
   * `runDiscoveryPass`. Default cadence is every 30 seconds — enough to
   * pick up new Codex CLI sessions promptly without burning subprocess
   * spawns. Idempotent: calling this twice is a no-op.
   *
   * The idempotency guard is `discoveryLoopStarted`, set synchronously
   * before the first `tick()` runs. Checking only `discoveryTimer` would
   * race because that field stays null until the FIRST `runDiscoveryPass`
   * resolves and the next setTimeout is scheduled — a window where a
   * second call would spawn a parallel loop.
   *
   * Stop via `stopDiscoveryLoop()` (called from daemon shutdown).
   */
  startDiscoveryLoop(intervalMs = 30_000): void {
    if (this.discoveryLoopStarted || this.discoveryStopped) return;
    this.discoveryLoopStarted = true;

    const tick = async () => {
      try {
        await this.runDiscoveryPass();
      } catch (err) {
        process.stderr.write(`[spawntree-daemon] discovery pass failed: ${String(err)}\n`);
      }
      // setTimeout chain (not setInterval) so we never overlap two passes
      // when an adapter is slow.
      if (!this.discoveryStopped) {
        this.discoveryTimer = setTimeout(() => void tick(), intervalMs);
      }
    };

    // Kick off the first pass immediately so the cache is warm before any
    // HTTP request lands. Don't `await` — let the daemon finish booting.
    void tick();
  }

  stopDiscoveryLoop(): void {
    this.discoveryStopped = true;
    this.discoveryLoopStarted = false;
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  /**
   * Create a new session with the given provider.
   * Starts the adapter if it hasn't been started yet.
   *
   * Order matters: we subscribe to the adapter's event stream BEFORE
   * calling `createSession`. The adapter may emit session events during
   * the startup handshake (status transitions, initialization echoes,
   * etc.); subscribing afterwards would drop those early events because
   * the adapter's internal handler set was empty at emission time.
   * `subscribeToAdapter` is idempotent per-provider, so calling it
   * here is a safe no-op when a previous call already wired things up.
   */
  async createSession(
    provider: string,
    params: {
      cwd: string;
      mcpServers?: unknown[];
      sandboxId?: string;
      newSandbox?: NewSessionSandbox;
    },
  ): Promise<{ sessionId: string }> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.createSession) {
      throw new ProviderCapabilityError(provider, "createSession");
    }
    this.subscribeToAdapter(provider, adapter);

    // Resolve the sandbox: attach to an existing one, or spin up an ephemeral
    // sandbox for this session (mount-mode at the session cwd, so the agent
    // sees the same worktree at the same path inside the container).
    const sandboxId = await this.resolveSessionSandbox(
      params.sandboxId,
      params.newSandbox,
      params.cwd,
    );

    const result = await adapter.createSession({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(sandboxId ? { sandboxId } : {}),
    });
    // Index so subsequent operations route directly without iterating
    // every adapter's discoverSessions() (which would spawn subprocesses).
    this.sessionIndex.set(result.sessionId, provider);

    // Invalidate the discovery cache so the next `listSessions()` call
    // returns fresh data including this new session. Without this, the
    // 30s cache window served stale lists immediately after creation —
    // the Studio's create-session flow then routed the user back to a
    // pre-existing session because the new id wasn't in the response.
    this.discoveryCacheAt = 0;

    // Mirror the session row into the catalog so list/get can come from
    // Drizzle without bouncing through the adapter subprocess, and so
    // configured upstream sync captures session metadata.
    if (this.catalog) {
      await upsertSession(this.catalog, {
        sessionId: result.sessionId,
        provider,
        status: "idle",
        workingDirectory: params.cwd,
        ...(sandboxId ? { sandboxId } : {}),
      }).catch((err) => {
        // Non-fatal: in-memory routing still works; surface on next write.
        process.stderr.write(
          `[spawntree-daemon] session persist failed on create: ${String(err)}\n`,
        );
      });
    }
    return result;
  }

  /**
   * Resolve the sandbox a new session should run in. Returns the existing
   * `sandboxId` if given, creates an ephemeral sandbox when `newSandbox` is
   * requested, or `undefined` to run on the host (the default).
   */
  private async resolveSessionSandbox(
    sandboxId: string | undefined,
    newSandbox: NewSessionSandbox | undefined,
    cwd: string,
  ): Promise<string | undefined> {
    if (sandboxId) return sandboxId;
    if (!newSandbox) return undefined;
    if (!this.sandboxManager) {
      throw new Error("Cannot create a sandboxed session: no sandbox manager configured");
    }
    const providerId = this.sandboxManager.resolveProviderId(newSandbox.provider);
    if (!providerId) {
      throw new Error("No sandbox provider is available for an ephemeral session");
    }
    const sandbox = await this.sandboxManager.createSandbox(providerId, {
      workspace: { mode: "mount", worktreePath: cwd },
      ephemeral: true,
      ...(newSandbox.image ? { image: newSandbox.image } : {}),
      ...(newSandbox.resources ? { resources: newSandbox.resources } : {}),
    });
    return sandbox.id;
  }

  /**
   * Get session detail (turns + tool calls) from the owning adapter.
   * Searches all adapters if no explicit provider is given.
   */
  async getSessionDetail(sessionId: string): Promise<ACPSessionDetail> {
    const [, adapter] = await this.findSession(sessionId);
    const detail = await adapter.getSessionDetail(sessionId);
    return this.patchPendingApprovals(detail);
  }

  /**
   * Read the persisted catalog copy of a session detail without touching the
   * live adapter. Used by HTTP routes as a bounded fallback when an adapter
   * blocks while rehydrating a dormant session.
   */
  async getPersistedSessionDetail(sessionId: string): Promise<ACPSessionDetail | undefined> {
    if (!this.catalog) return undefined;
    const snapshot = await loadAdoptableSession(this.catalog, sessionId);
    if (!snapshot) return undefined;
    return {
      turns: snapshot.turns,
      toolCalls: snapshot.toolCalls,
    };
  }

  /**
   * Get the summary info for a session.
   */
  async getSessionInfo(sessionId: string): Promise<DiscoveredSession & { provider: string }> {
    const [provider, adapter] = await this.findSession(sessionId);
    const sessions = await adapter.discoverSessions();
    const found = sessions.find((s) => s.sourceId === sessionId);
    if (!found) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return { ...found, provider };
  }

  /** Send a message to a session. */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    const [provider, adapter] = await this.findSession(sessionId);
    // Ensure we're subscribed to events from this adapter.
    this.subscribeToAdapter(provider, adapter);
    await adapter.sendMessage(sessionId, content);
  }

  /** Cancel the active turn in a session. */
  async interrupt(sessionId: string): Promise<void> {
    const [, adapter] = await this.findSession(sessionId);
    await adapter.interruptSession(sessionId);
  }

  /** Resume a dormant session. */
  async resume(sessionId: string): Promise<void> {
    const [, adapter] = await this.findSession(sessionId);
    await adapter.resumeSession(sessionId);
  }

  /**
   * Delete a session by dispatching to the owning adapter. Adapters that
   * do not support deletion (e.g. Codex, whose app-server has no delete
   * RPC) throw `SessionDeleteUnsupportedError` which the HTTP layer maps
   * to 501 Not Implemented.
   *
   * After a successful delete we drop the session from the index so
   * subsequent lookups don't route to a stale provider.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const [provider, adapter] = await this.findSession(sessionId);
    if (!adapter.deleteSession) {
      throw new SessionDeleteUnsupportedError(sessionId, provider);
    }
    await adapter.deleteSession(sessionId);
    this.sessionIndex.delete(sessionId);
    // Invalidate the discovery cache so the deleted session disappears
    // from `listSessions()` immediately. Without this, the UI would
    // continue showing the deleted session for up to 30s.
    this.discoveryCacheAt = 0;
    if (this.catalog) {
      await deletePersistedSession(this.catalog, sessionId).catch(() => undefined);
    }
  }

  /**
   * List sessions from the catalog DB. Fast path that doesn't spawn any
   * adapter subprocesses. External Drizzle clients querying the same
   * tables see identical data.
   *
   * Returns an empty array when no StorageManager is wired up (tests,
   * legacy paths). Callers that need live discovery hit `listSessions()`.
   */
  async listPersistedSessions(): Promise<Array<SessionInfo>> {
    if (!this.catalog) return [];
    return listPersistedSessions(this.catalog);
  }

  /** Same shape as `listPersistedSessions` but for a single session. */
  async getPersistedSession(sessionId: string): Promise<SessionInfo | undefined> {
    if (!this.catalog) return undefined;
    return getPersistedSession(this.catalog, sessionId);
  }

  /**
   * Subscribe to per-session events from a specific session.
   * Returns an async generator that yields events until the signal fires.
   *
   * The sessionId filter is applied at the DomainEvents layer (including
   * during history replay) so a fresh subscriber doesn't receive a flood
   * of events from other sessions before it gets its own live stream.
   */
  async *sessionEvents(sessionId: string, signal?: AbortSignal): AsyncIterable<SessionEvent> {
    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;

    const push = (event: SessionEvent) => {
      queue.push(event);
      wake?.();
    };

    // Push-down the sessionId filter so history replay is also scoped.
    const cleanup = this.events.subscribeSessionEvent(push, sessionId);
    signal?.addEventListener("abort", () => {
      done = true;
      wake?.();
    });

    try {
      while (!done) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      cleanup();
    }
  }

  /** Shut down all adapters. Called when the daemon process exits. */
  async shutdown(): Promise<void> {
    this.stopDiscoveryLoop();
    for (const unsub of this.unsubscribers.values()) {
      try {
        unsub();
      } catch {
        // best-effort
      }
    }
    this.unsubscribers.clear();
    this.subscribedProviders.clear();
    for (const adapter of this.adapters.values()) {
      await adapter.shutdown().catch(() => {});
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Fill in any null git metadata on a discovered session by running
   * `git` against its `workingDirectory`. Returns the merged result so
   * the caller can pass it straight into `upsertSession`.
   *
   * If the adapter already reported all three (branch/headCommit/remoteUrl),
   * this is a zero-cost passthrough. Otherwise we look up the cached
   * detection for the cwd, and if there's no cached entry, we run
   * `detectGitMetadata` (synchronous git CLI) and cache the result.
   *
   * Sessions whose `workingDirectory` no longer exists on disk (deleted
   * worktree, machine moved, etc.) skip detection — the existing nulls
   * stay nulls, which is correct: those sessions can't be linked to a
   * current branch anyway.
   */
  private backfillGitMetadata(session: DiscoveredSession): GitMetadata {
    if (session.gitBranch && session.gitHeadCommit && session.gitRemoteUrl) {
      return {
        branch: session.gitBranch,
        headCommit: session.gitHeadCommit,
        remoteUrl: session.gitRemoteUrl,
      };
    }

    const cwd = session.workingDirectory;
    const adapterMeta: GitMetadata = {
      branch: session.gitBranch ?? null,
      headCommit: session.gitHeadCommit ?? null,
      remoteUrl: session.gitRemoteUrl ?? null,
    };
    if (!cwd) return adapterMeta;

    const cached = this.gitMetadataCache.get(cwd);
    if (cached) {
      return {
        branch: adapterMeta.branch ?? cached.branch,
        headCommit: adapterMeta.headCommit ?? cached.headCommit,
        remoteUrl: adapterMeta.remoteUrl ?? cached.remoteUrl,
      };
    }

    // A missing path would just give us all-null git output. Skip the
    // spawns and don't cache, so a recreated worktree gets a fresh
    // detection on the next discovery pass.
    if (!existsSync(cwd)) return adapterMeta;

    const detected = detectGitMetadata(cwd);
    this.gitMetadataCache.set(cwd, detected);
    return {
      branch: adapterMeta.branch ?? detected.branch,
      headCommit: adapterMeta.headCommit ?? detected.headCommit,
      remoteUrl: adapterMeta.remoteUrl ?? detected.remoteUrl,
    };
  }

  private requireAdapter(provider: string): ACPAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new UnknownProviderError(provider, [...this.adapters.keys()]);
    }
    return adapter;
  }

  /**
   * Find which adapter owns a given sessionId.
   *
   * Fast path: consult the `sessionIndex` cache populated by
   * `createSession` and `listSessions`. This avoids iterating every
   * adapter on each call — crucially, it avoids triggering
   * `discoverSessions` on adapters whose implementations spawn a
   * subprocess (e.g. CodexACPAdapter), so a Claude Code session
   * operation does not boot a Codex subprocess it never needed.
   *
   * Slow path: if the cache misses, fall back to iterating available
   * adapters and populate the cache with everything we discover on the
   * way. Unavailable adapters (binary not installed) are skipped so we
   * don't spawn them speculatively.
   */
  private async findSession(sessionId: string): Promise<[string, ACPAdapter]> {
    const cached = this.sessionIndex.get(sessionId);
    if (cached) {
      const adapter = this.adapters.get(cached);
      if (adapter) {
        return [cached, adapter];
      }
      // Provider was removed — stale cache entry, fall through to rediscover.
      this.sessionIndex.delete(sessionId);
    }

    for (const [provider, adapter] of this.adapters) {
      try {
        if (!(await adapter.isAvailable())) continue;
      } catch {
        continue;
      }
      try {
        const sessions = await adapter.discoverSessions();
        let hit: [string, ACPAdapter] | null = null;
        for (const s of sessions) {
          this.sessionIndex.set(s.sourceId, provider);
          if (s.sourceId === sessionId) {
            hit = [provider, adapter];
          }
        }
        if (hit) return hit;
      } catch {
        // Adapter unreachable — skip.
      }
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  /**
   * Subscribe to a provider's event stream exactly once and forward events
   * to the DomainEvents bus. Idempotent — subsequent calls for the same
   * provider are no-ops. Storing the unsubscribe function keyed by
   * provider name lets `registerAdapter` tear it down cleanly when the
   * adapter is replaced.
   */
  /**
   * Chain a persistence write after any previous write for the same
   * session so adapter events land in order (turn_started → turn_completed
   * must run its UPDATE after the INSERT has landed, not concurrent with it).
   *
   * Returns a promise the caller can await (tests use `flushPersist()`
   * which awaits all active queues). If the catalog isn't wired up, this
   * is a no-op — callers get back a resolved promise.
   */
  private enqueuePersist(sessionId: string, op: () => Promise<void>): Promise<void> {
    if (!this.catalog) return Promise.resolve();
    const prev = this.persistQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(op);
    // Swallow rejections in the stored reference so one failure doesn't
    // permanently break the chain. `op` itself already logs errors.
    this.persistQueues.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Wait for all queued persistence writes to drain. Tests call this
   * after emitting events to make their assertions deterministic. The
   * shutdown path also awaits it to avoid truncating in-flight writes.
   */
  async flushPersist(): Promise<void> {
    const queues = [...this.persistQueues.values()];
    await Promise.all(queues.map((q) => q.catch(() => undefined)));
  }

  private subscribeToAdapter(provider: string, adapter: ACPAdapter): void {
    if (this.subscribedProviders.has(provider)) return;
    this.subscribedProviders.add(provider);

    const unsub = adapter.onSessionEvent((event) => {
      // Publish to domain events bus — SSE subscribers will receive it.
      this.events.publishSessionEvent(event, provider);

      // Mirror into the catalog so sessions survive restart + are visible
      // to external Drizzle clients. Chain per-session so events land in
      // emission order; errors are logged but don't break the chain so
      // one bad write can't wedge the queue.
      void this.enqueuePersist(event.sessionId, () =>
        persistSessionEvent(this.catalog!, event).catch((err) => {
          process.stderr.write(
            `[spawntree-daemon] session persist failed on ${event.type}: ${String(err)}\n`,
          );
        }),
      );

      // On turn_completed, backfill the turn's final content (+ stop reason,
      // duration, modelId) by asking the adapter once. We deliberately skip
      // persisting `message_delta` frames to avoid write amplification;
      // hydration on completion is the catch-up mechanism so external
      // Drizzle readers see fully-assembled turn content without having
      // to call the adapter subprocess themselves.
      if (event.type === "turn_completed") {
        void this.enqueuePersist(event.sessionId, async () => {
          await this.hydrateTurnAfterCompletion(adapter, event.sessionId, event.turnId);
        });
      }
    });
    this.unsubscribers.set(provider, unsub);
  }

  /**
   * Fetch session detail from the adapter and backfill the matching turn
   * row's content + metadata. Best-effort: any failure (adapter subprocess
   * crashed, session vanished, network blip) is logged and swallowed so
   * one bad hydration doesn't wedge the persistence queue.
   *
   * Small by design: exactly one `getSessionDetail` call per completed
   * turn. If the adapter responds cheaply from its own cache, this is a
   * constant-time backfill.
   */
  private async hydrateTurnAfterCompletion(
    adapter: ACPAdapter,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (!this.catalog) return;
    try {
      const detail = await adapter.getSessionDetail(sessionId);
      const turn = detail.turns.find((t) => t.id === turnId);
      if (turn) {
        await hydrateTurnContent(this.catalog, turn);
      }
    } catch (err) {
      process.stderr.write(
        `[spawntree-daemon] turn hydration failed for ${sessionId}/${turnId}: ${String(err)}\n`,
      );
    }
  }
}

/**
 * Build a `SessionToolCallData` row from an ACP `request_permission` request.
 * The adapter has already emitted a `tool_call_started` event for the same
 * id — this transitional row carries the same identity but with status
 * `awaiting_approval` and the agent's offered options attached.
 */
// Return type intentionally inferred: TypeScript infers a literal shape with
// a mutable `approvalOptions` array, which is assignable to both the
// adapter-side `SessionToolCallData` (mutable) and the Effect-derived schema
// type (readonly). Annotating the return as `SessionToolCallData` would
// pin to one or the other and break the SessionEvent assignment downstream.
function approvalToolCallFromRequest(
  params: ACPRequestPermissionRequest,
  options: ToolCallApprovalOption[],
) {
  const tc = params.toolCall;
  return {
    id: tc.toolCallId,
    turnId: null,
    toolName: tc.title ?? "tool",
    toolKind: mapAcpToolKind(tc.kind),
    status: "awaiting_approval" as const,
    arguments: tc.rawInput ?? null,
    result: null,
    durationMs: null,
    createdAt: new Date().toISOString(),
    approvalOptions: options,
  };
}

function mapAcpToolKind(kind: string | undefined | null): SessionToolCallData["toolKind"] {
  switch (kind) {
    case "execute":
      return "terminal";
    case "edit":
    case "move":
    case "delete":
      return "file_edit";
    default:
      return "other";
  }
}
