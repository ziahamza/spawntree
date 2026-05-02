import { Schema } from "effect";

export const RepoId = Schema.String;
export type RepoId = Schema.Schema.Type<typeof RepoId>;

export const EnvId = Schema.String;
export type EnvId = Schema.Schema.Type<typeof EnvId>;

export const CloneId = Schema.String;
export type CloneId = Schema.Schema.Type<typeof CloneId>;

export const RepoSlug = Schema.String;
export type RepoSlug = Schema.Schema.Type<typeof RepoSlug>;

export const ServiceStatus = Schema.Literals(["starting", "running", "failed", "stopped"]);
export type ServiceStatus = Schema.Schema.Type<typeof ServiceStatus>;

export const ServiceType = Schema.Literals([
  "process",
  "container",
  "postgres",
  "redis",
  "external",
]);
export type ServiceType = Schema.Schema.Type<typeof ServiceType>;

export const InfraStatus = Schema.Literals(["running", "stopped", "starting", "error"]);
export type InfraStatus = Schema.Schema.Type<typeof InfraStatus>;

export const ServiceInfo = Schema.Struct({
  name: Schema.String,
  type: ServiceType,
  status: ServiceStatus,
  port: Schema.Number,
  pid: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  containerId: Schema.optional(Schema.String),
});
export type ServiceInfo = Schema.Schema.Type<typeof ServiceInfo>;

export const EnvInfo = Schema.Struct({
  envId: EnvId,
  repoId: RepoId,
  repoPath: Schema.String,
  branch: Schema.String,
  basePort: Schema.Number,
  createdAt: Schema.String,
  services: Schema.Array(ServiceInfo),
});
export type EnvInfo = Schema.Schema.Type<typeof EnvInfo>;

export const DaemonInfo = Schema.Struct({
  version: Schema.String,
  pid: Schema.Number,
  uptime: Schema.Number,
  repos: Schema.Number,
  activeEnvs: Schema.Number,
});
export type DaemonInfo = Schema.Schema.Type<typeof DaemonInfo>;

export const PostgresInstanceInfo = Schema.Struct({
  version: Schema.String,
  status: InfraStatus,
  port: Schema.Number,
  dataDir: Schema.String,
  databases: Schema.Array(Schema.String),
  containerId: Schema.optional(Schema.String),
});
export type PostgresInstanceInfo = Schema.Schema.Type<typeof PostgresInstanceInfo>;

export const RedisInstanceInfo = Schema.Struct({
  status: InfraStatus,
  port: Schema.Number,
  allocatedDbIndices: Schema.Number,
  containerId: Schema.optional(Schema.String),
});
export type RedisInstanceInfo = Schema.Schema.Type<typeof RedisInstanceInfo>;

export const InfraStatusResponse = Schema.Struct({
  postgres: Schema.Array(PostgresInstanceInfo),
  redis: Schema.optional(RedisInstanceInfo),
});
export type InfraStatusResponse = Schema.Schema.Type<typeof InfraStatusResponse>;

// ─── Storage / host-sync ───────────────────────────────────────────────────
//
// Mirrors the union returned by `HostConfigSync.getStatus()` on the daemon.
// Kept loose — `Schema.Unknown` is safer than tagging every variant because
// the dashboard treats this as a display shape, not a domain operation.
//
// `null` here is a deliberate signal — the daemon was started without a
// `--host` binding (standalone mode). The dashboard renders that as
// "Standalone — local storage only".
export const HostSyncState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("fetching"), since: Schema.String }),
  Schema.Struct({
    state: Schema.Literal("synced"),
    lastSyncAt: Schema.String,
    daemonLabel: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("awaiting_config"),
    lastCheckAt: Schema.String,
    daemonLabel: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("error"),
    lastErrorAt: Schema.String,
    error: Schema.String,
    nextRetryAt: Schema.String,
  }),
]);
export type HostSyncState = Schema.Schema.Type<typeof HostSyncState>;

/**
 * `GET /api/v1/storage` shape consumed by the dashboard's infra page.
 * Loose on `config` shapes since they vary per provider — we only need
 * IDs for display.
 */
export const StorageStatusResponse = Schema.Struct({
  primary: Schema.Struct({
    id: Schema.String,
    config: Schema.Unknown,
    status: Schema.Unknown,
  }),
  replicators: Schema.Array(
    Schema.Struct({
      rid: Schema.String,
      id: Schema.String,
      config: Schema.Unknown,
      status: Schema.Unknown,
    }),
  ),
  availableProviders: Schema.Struct({
    primaries: Schema.Array(Schema.Struct({ id: Schema.String })),
    replicators: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
  migrating: Schema.Boolean,
  hostSync: Schema.NullOr(HostSyncState),
});
export type StorageStatusResponse = Schema.Schema.Type<typeof StorageStatusResponse>;

export const ApiError = Schema.Struct({
  error: Schema.String,
  code: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type ApiError = Schema.Schema.Type<typeof ApiError>;

export const CreateEnvRequest = Schema.Struct({
  repoPath: Schema.String,
  envId: Schema.optional(EnvId),
  prefix: Schema.optional(Schema.String),
  envOverrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  configFile: Schema.optional(Schema.String),
  skipHealthcheckWait: Schema.optional(Schema.Boolean),
});
export type CreateEnvRequest = Schema.Schema.Type<typeof CreateEnvRequest>;

export const CreateEnvResponse = Schema.Struct({
  env: EnvInfo,
});
export type CreateEnvResponse = Schema.Schema.Type<typeof CreateEnvResponse>;

export const GetEnvResponse = Schema.Struct({
  env: EnvInfo,
});
export type GetEnvResponse = Schema.Schema.Type<typeof GetEnvResponse>;

export const ListEnvsResponse = Schema.Struct({
  envs: Schema.Array(EnvInfo),
});
export type ListEnvsResponse = Schema.Schema.Type<typeof ListEnvsResponse>;

export const OkResponse = Schema.Struct({
  ok: Schema.Boolean,
});
export type OkResponse = Schema.Schema.Type<typeof OkResponse>;

export const LogLine = Schema.Struct({
  ts: Schema.String,
  service: Schema.String,
  stream: Schema.Literals(["stdout", "stderr", "system"]),
  line: Schema.String,
});
export type LogLine = Schema.Schema.Type<typeof LogLine>;

export const RegisteredRepo = Schema.Struct({
  repoId: RepoId,
  repoPath: Schema.String,
  configPath: Schema.String,
  lastSeenAt: Schema.String,
});
export type RegisteredRepo = Schema.Schema.Type<typeof RegisteredRepo>;

export const RegisterRepoRequest = Schema.Struct({
  repoPath: Schema.String,
  configPath: Schema.String,
});
export type RegisterRepoRequest = Schema.Schema.Type<typeof RegisterRepoRequest>;

export const RegisterRepoResponse = Schema.Struct({
  repo: RegisteredRepo,
});
export type RegisterRepoResponse = Schema.Schema.Type<typeof RegisterRepoResponse>;

export const StopInfraRequest = Schema.Struct({
  target: Schema.Literals(["postgres", "redis", "all"]),
  version: Schema.optional(Schema.String),
});
export type StopInfraRequest = Schema.Schema.Type<typeof StopInfraRequest>;

export const StopInfraResponse = OkResponse;
export type StopInfraResponse = Schema.Schema.Type<typeof StopInfraResponse>;

export const DbTemplate = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  createdAt: Schema.String,
  sourceDatabaseUrl: Schema.optional(Schema.String),
});
export type DbTemplate = Schema.Schema.Type<typeof DbTemplate>;

export const ListDbTemplatesResponse = Schema.Struct({
  templates: Schema.Array(DbTemplate),
});
export type ListDbTemplatesResponse = Schema.Schema.Type<typeof ListDbTemplatesResponse>;

export const DumpDbRequest = Schema.Struct({
  repoPath: Schema.String,
  envId: EnvId,
  dbName: Schema.String,
  templateName: Schema.String,
});
export type DumpDbRequest = Schema.Schema.Type<typeof DumpDbRequest>;

export const DumpDbResponse = Schema.Struct({
  template: DbTemplate,
});
export type DumpDbResponse = Schema.Schema.Type<typeof DumpDbResponse>;

export const RestoreDbRequest = Schema.Struct({
  repoPath: Schema.String,
  envId: EnvId,
  dbName: Schema.String,
  templateName: Schema.String,
});
export type RestoreDbRequest = Schema.Schema.Type<typeof RestoreDbRequest>;

export const RestoreDbResponse = OkResponse;
export type RestoreDbResponse = Schema.Schema.Type<typeof RestoreDbResponse>;

export const Repo = Schema.Struct({
  id: Schema.String,
  slug: RepoSlug,
  name: Schema.String,
  provider: Schema.String,
  owner: Schema.String,
  remoteUrl: Schema.String,
  defaultBranch: Schema.String,
  description: Schema.String,
  registeredAt: Schema.String,
  updatedAt: Schema.String,
});
export type Repo = Schema.Schema.Type<typeof Repo>;

export const Clone = Schema.Struct({
  id: CloneId,
  repoId: Schema.String,
  path: Schema.String,
  status: Schema.String,
  lastSeenAt: Schema.String,
  registeredAt: Schema.String,
});
export type Clone = Schema.Schema.Type<typeof Clone>;

export const Worktree = Schema.Struct({
  path: Schema.String,
  cloneId: CloneId,
  branch: Schema.String,
  headRef: Schema.String,
  discoveredAt: Schema.String,
});
export type Worktree = Schema.Schema.Type<typeof Worktree>;

export const GitRemote = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
});
export type GitRemote = Schema.Schema.Type<typeof GitRemote>;

export const WatchedPath = Schema.Struct({
  path: Schema.String,
  scanChildren: Schema.Boolean,
  addedAt: Schema.String,
  lastScannedAt: Schema.optional(Schema.String),
  lastScanError: Schema.optional(Schema.String),
});
export type WatchedPath = Schema.Schema.Type<typeof WatchedPath>;

export const WebRepo = Schema.Struct({
  slug: RepoSlug,
  name: Schema.String,
  remoteUrl: Schema.optional(Schema.String),
  cloneCount: Schema.Number,
  activeEnvCount: Schema.Number,
  overallStatus: Schema.Literals(["running", "starting", "stopped", "crashed", "offline"]),
  updatedAt: Schema.String,
});
export type WebRepo = Schema.Schema.Type<typeof WebRepo>;

export const GitPathInfo = Schema.Struct({
  branch: Schema.String,
  headRef: Schema.String,
  activityAt: Schema.String,
  insertions: Schema.Number,
  deletions: Schema.Number,
  hasUncommittedChanges: Schema.Boolean,
  isMergedIntoBase: Schema.Boolean,
  isBaseOutOfDate: Schema.Boolean,
  isBaseBranch: Schema.Boolean,
  canArchive: Schema.Boolean,
  baseRefName: Schema.optional(Schema.String),
});
export type GitPathInfo = Schema.Schema.Type<typeof GitPathInfo>;

export const WebListReposResponse = Schema.Struct({
  repos: Schema.Array(WebRepo),
});
export type WebListReposResponse = Schema.Schema.Type<typeof WebListReposResponse>;

export const WebRepoDetailResponse = Schema.Struct({
  repo: Repo,
  clones: Schema.Array(Clone),
  worktrees: Schema.Record(CloneId, Schema.Array(Worktree)),
  envs: Schema.Array(EnvInfo),
  gitPaths: Schema.Record(Schema.String, GitPathInfo),
});
export type WebRepoDetailResponse = Schema.Schema.Type<typeof WebRepoDetailResponse>;

export const WebRepoTreeResponse = Schema.Struct({
  repo: Repo,
  clones: Schema.Array(Clone),
  worktrees: Schema.Record(CloneId, Schema.Array(Worktree)),
  envs: Schema.Array(EnvInfo),
});
export type WebRepoTreeResponse = Schema.Schema.Type<typeof WebRepoTreeResponse>;

export const AddFolderRequest = Schema.Struct({
  path: Schema.String,
  remoteName: Schema.optional(Schema.String),
  scanChildren: Schema.optional(Schema.Boolean),
});
export type AddFolderRequest = Schema.Schema.Type<typeof AddFolderRequest>;

export const AddFolderResponse = Schema.Struct({
  repo: Schema.optional(Repo),
  clone: Schema.optional(Clone),
  remotes: Schema.optional(Schema.Array(GitRemote)),
  watchedPath: Schema.optional(WatchedPath),
  importedCount: Schema.optional(Schema.Number),
});
export type AddFolderResponse = Schema.Schema.Type<typeof AddFolderResponse>;

export const AddFolderProbeResult = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  isGitRepo: Schema.Boolean,
  canScanChildren: Schema.Boolean,
  childRepoCount: Schema.Number,
});
export type AddFolderProbeResult = Schema.Schema.Type<typeof AddFolderProbeResult>;

export const RelinkCloneRequest = Schema.Struct({
  path: Schema.String,
});
export type RelinkCloneRequest = Schema.Schema.Type<typeof RelinkCloneRequest>;

export const ArchiveWorktreeRequest = Schema.Struct({
  path: Schema.String,
});
export type ArchiveWorktreeRequest = Schema.Schema.Type<typeof ArchiveWorktreeRequest>;

export const ConfigSignal = Schema.Struct({
  kind: Schema.String,
  label: Schema.String,
  detail: Schema.String,
});
export type ConfigSignal = Schema.Schema.Type<typeof ConfigSignal>;

export const ConfigServiceSuggestion = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: ServiceType,
  command: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  healthcheckUrl: Schema.optional(Schema.String),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  selected: Schema.Boolean,
});
export type ConfigServiceSuggestion = Schema.Schema.Type<typeof ConfigServiceSuggestion>;

export const ConfigSuggestRequest = Schema.Struct({
  repoPath: Schema.String,
});
export type ConfigSuggestRequest = Schema.Schema.Type<typeof ConfigSuggestRequest>;

export const ConfigSuggestResponse = Schema.Struct({
  signals: Schema.Array(ConfigSignal),
  services: Schema.Array(ConfigServiceSuggestion),
});
export type ConfigSuggestResponse = Schema.Schema.Type<typeof ConfigSuggestResponse>;

export const ConfigTestRequest = Schema.Struct({
  repoPath: Schema.String,
  content: Schema.String,
});
export type ConfigTestRequest = Schema.Schema.Type<typeof ConfigTestRequest>;

export const ConfigTestServiceResult = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  status: Schema.String,
  url: Schema.optional(Schema.String),
  previewUrl: Schema.optional(Schema.String),
  probeOk: Schema.Boolean,
  probeStatusCode: Schema.optional(Schema.Number),
  probeBodyPreview: Schema.optional(Schema.String),
  probeError: Schema.optional(Schema.String),
  logs: Schema.Array(Schema.String),
});
export type ConfigTestServiceResult = Schema.Schema.Type<typeof ConfigTestServiceResult>;

export const ConfigTestResponse = Schema.Struct({
  ok: Schema.Boolean,
  serviceNames: Schema.Array(Schema.String),
  services: Schema.Array(ConfigTestServiceResult),
});
export type ConfigTestResponse = Schema.Schema.Type<typeof ConfigTestResponse>;

export const ConfigPreviewRequest = Schema.Struct({
  repoPath: Schema.String,
  content: Schema.String,
  serviceName: Schema.optional(Schema.String),
});
export type ConfigPreviewRequest = Schema.Schema.Type<typeof ConfigPreviewRequest>;

export const ConfigPreviewResponse = Schema.Struct({
  ok: Schema.Boolean,
  previewId: Schema.String,
  env: EnvInfo,
});
export type ConfigPreviewResponse = Schema.Schema.Type<typeof ConfigPreviewResponse>;

export const ConfigPreviewStopRequest = Schema.Struct({
  previewId: Schema.String,
});
export type ConfigPreviewStopRequest = Schema.Schema.Type<typeof ConfigPreviewStopRequest>;

export const ConfigSaveRequest = Schema.Struct({
  repoPath: Schema.String,
  content: Schema.String,
  saveMode: Schema.Literals(["repo", "global"]),
});
export type ConfigSaveRequest = Schema.Schema.Type<typeof ConfigSaveRequest>;

export const ConfigSaveResponse = Schema.Struct({
  ok: Schema.Boolean,
  configPath: Schema.String,
  saveMode: Schema.Literals(["repo", "global"]),
});
export type ConfigSaveResponse = Schema.Schema.Type<typeof ConfigSaveResponse>;

export const DomainEvent = Schema.Struct({
  seq: Schema.Number,
  type: Schema.String,
  timestamp: Schema.String,
  repoId: Schema.optional(Schema.String),
  repoSlug: Schema.optional(Schema.String),
  envId: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type DomainEvent = Schema.Schema.Type<typeof DomainEvent>;

// ─── Session API types ──────────────────────────────────────────────────────

/**
 * Session provider identifier. Two built-in providers (`claude-code`,
 * `codex`) are always recognized; custom providers registered via
 * `SessionManager.registerAdapter` are also accepted, so this is a
 * `Schema.String` rather than a closed `Schema.Literals`. Unknown
 * providers are rejected by the SessionManager at dispatch time with a
 * clear error, not at schema decode.
 */
export const SessionProvider = Schema.String;
export type SessionProvider = Schema.Schema.Type<typeof SessionProvider>;

/**
 * The two built-in providers. Kept separate for UI enumeration.
 *
 * Explicitly type-annotated as a `readonly` tuple literal rather than
 * using `as const` — the project's biome linteffect rule rejects `as`
 * assertions on model-flow values. The annotation gives us the same
 * narrowed types without an assertion.
 */
export type BuiltinSessionProvider = "claude-code" | "codex";
export const BUILTIN_SESSION_PROVIDERS: readonly BuiltinSessionProvider[] = [
  "claude-code",
  "codex",
];

export const SessionStatus = Schema.Literals([
  "idle",
  "streaming",
  "waiting",
  "completed",
  "error",
]);
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

export const SessionInfo = Schema.Struct({
  sessionId: Schema.String,
  provider: SessionProvider,
  status: SessionStatus,
  title: Schema.NullOr(Schema.String),
  workingDirectory: Schema.String,
  gitBranch: Schema.NullOr(Schema.String),
  gitHeadCommit: Schema.NullOr(Schema.String),
  gitRemoteUrl: Schema.NullOr(Schema.String),
  totalTurns: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type SessionInfo = Schema.Schema.Type<typeof SessionInfo>;

export const ListSessionsResponse = Schema.Struct({
  sessions: Schema.Array(SessionInfo),
});
export type ListSessionsResponse = Schema.Schema.Type<typeof ListSessionsResponse>;

export const CreateSessionRequest = Schema.Struct({
  provider: SessionProvider,
  cwd: Schema.String,
  mcpServers: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type CreateSessionRequest = Schema.Schema.Type<typeof CreateSessionRequest>;

export const CreateSessionResponse = Schema.Struct({
  sessionId: Schema.String,
  provider: SessionProvider,
});
export type CreateSessionResponse = Schema.Schema.Type<typeof CreateSessionResponse>;

export const SendSessionMessageRequest = Schema.Struct({
  content: Schema.String,
});
export type SendSessionMessageRequest = Schema.Schema.Type<typeof SendSessionMessageRequest>;

/**
 * Permission option offered by the agent on a `request_permission` RPC.
 * Mirrors `@zed-industries/agent-client-protocol` PermissionOption — kept
 * as a local schema so consumers don't need an ACP-specific dependency.
 */
export const ToolCallApprovalOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type ToolCallApprovalOption = Schema.Schema.Type<typeof ToolCallApprovalOption>;

/**
 * User response to a pending approval prompt. Matches ACP
 * `RequestPermissionResponse.outcome` shape so the daemon can pass it
 * through to the agent without translation.
 */
export const RespondToToolCallRequest = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("selected"),
    optionId: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.Literal("cancelled"),
  }),
]);
export type RespondToToolCallRequest = Schema.Schema.Type<typeof RespondToToolCallRequest>;

export const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String,
    oldText: Schema.optional(Schema.String),
    newText: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    command: Schema.String,
    output: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    durationMs: Schema.NullOr(Schema.Number),
  }),
]);
export type ContentBlock = Schema.Schema.Type<typeof ContentBlock>;

export const SessionTurnData = Schema.Struct({
  id: Schema.String,
  turnIndex: Schema.Number,
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Array(ContentBlock),
  modelId: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  stopReason: Schema.NullOr(Schema.String),
  status: Schema.Literals(["streaming", "completed", "error", "cancelled"]),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type SessionTurnData = Schema.Schema.Type<typeof SessionTurnData>;

export const SessionToolCallData = Schema.Struct({
  id: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  toolName: Schema.String,
  toolKind: Schema.Literals(["terminal", "file_edit", "mcp", "other"]),
  status: Schema.Literals(["pending", "in_progress", "awaiting_approval", "completed", "error"]),
  arguments: Schema.Unknown,
  result: Schema.Unknown,
  durationMs: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  /**
   * Set only while `status === "awaiting_approval"`. Carries the agent's
   * permission options so the UI can render Allow/Reject buttons. Cleared
   * when the tool call moves to a terminal status.
   */
  approvalOptions: Schema.optional(Schema.Array(ToolCallApprovalOption)),
});
export type SessionToolCallData = Schema.Schema.Type<typeof SessionToolCallData>;

export const SessionDetail = Schema.Struct({
  session: SessionInfo,
  turns: Schema.Array(SessionTurnData),
  toolCalls: Schema.Array(SessionToolCallData),
});
export type SessionDetail = Schema.Schema.Type<typeof SessionDetail>;

/**
 * Session event encoded as a DomainEvent `detail` payload.
 * Sent over the existing `/api/v1/events` SSE stream (type = "session_event")
 * and over the per-session `/api/v1/sessions/:id/events` SSE stream.
 */
export const SessionEventPayload = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("turn_started"),
    sessionId: Schema.String,
    turnId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("message_delta"),
    sessionId: Schema.String,
    turnId: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_started"),
    sessionId: Schema.String,
    toolCall: SessionToolCallData,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_completed"),
    sessionId: Schema.String,
    toolCall: SessionToolCallData,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_awaiting_approval"),
    sessionId: Schema.String,
    toolCall: SessionToolCallData,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_completed"),
    sessionId: Schema.String,
    turnId: Schema.String,
    status: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("session_status_changed"),
    sessionId: Schema.String,
    status: SessionStatus,
  }),
]);
export type SessionEventPayload = Schema.Schema.Type<typeof SessionEventPayload>;
