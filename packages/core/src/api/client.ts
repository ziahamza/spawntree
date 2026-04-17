import { Match, Option, Schema } from "effect";
import {
  AddFolderProbeResult,
  AddFolderResponse,
  ApiError,
  ConfigPreviewResponse,
  ConfigSaveResponse,
  ConfigSuggestResponse,
  ConfigTestResponse,
  CreateEnvResponse,
  CreateSessionResponse,
  DaemonInfo,
  DomainEvent,
  DumpDbResponse,
  GetEnvResponse,
  InfraStatusResponse,
  ListEnvsResponse,
  ListSessionsResponse,
  LogLine,
  RegisterRepoResponse,
  RestoreDbResponse,
  SessionDetail,
  SessionEventPayload,
  WebListReposResponse,
  WebRepoDetailResponse,
  WebRepoTreeResponse,
} from "./schemas.ts";
import type {
  AddFolderRequest,
  ArchiveWorktreeRequest,
  ConfigPreviewRequest,
  ConfigPreviewStopRequest,
  ConfigSaveRequest,
  ConfigSuggestRequest,
  ConfigTestRequest,
  CreateEnvRequest,
  CreateSessionRequest,
  DumpDbRequest,
  RegisterRepoRequest,
  RelinkCloneRequest,
  RestoreDbRequest,
  SendSessionMessageRequest,
  StopInfraRequest,
} from "./types.ts";

export interface ApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class ApiClientError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async getDaemonInfo() {
    return this.request("/api/v1/daemon", { schema: DaemonInfo });
  }

  async createEnv(body: CreateEnvRequest) {
    return this.request("/api/v1/envs", {
      method: "POST",
      body,
      schema: CreateEnvResponse,
    });
  }

  async listEnvs(repoId?: string) {
    const path = Option.fromNullishOr(repoId).pipe(
      Option.match({
        onNone: () => "/api/v1/envs",
        onSome: (value) => `/api/v1/repos/${encodeURIComponent(value)}/envs`,
      }),
    );
    return this.request(path, { schema: ListEnvsResponse });
  }

  async getEnv(repoId: string, envId: string, repoPath?: string) {
    return this.request(
      this.withSearch(
        `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}`,
        {
          repoPath,
        },
      ),
      { schema: GetEnvResponse },
    );
  }

  async downEnv(repoId: string, envId: string, repoPath?: string) {
    return this.request(
      this.withSearch(
        `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/down`,
        {
          repoPath,
        },
      ),
      { method: "POST" },
    );
  }

  async deleteEnv(repoId: string, envId: string, repoPath?: string) {
    return this.request(
      this.withSearch(
        `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}`,
        {
          repoPath,
        },
      ),
      { method: "DELETE" },
    );
  }

  async registerRepo(body: RegisterRepoRequest) {
    return this.request("/api/v1/registry/repos", {
      method: "POST",
      body,
      schema: RegisterRepoResponse,
    });
  }

  async getInfraStatus() {
    return this.request("/api/v1/infra", { schema: InfraStatusResponse });
  }

  async stopInfra(body: StopInfraRequest) {
    return this.request("/api/v1/infra/stop", {
      method: "POST",
      body,
    });
  }

  async dumpDb(body: DumpDbRequest) {
    return this.request("/api/v1/db/dump", {
      method: "POST",
      body,
      schema: DumpDbResponse,
    });
  }

  async restoreDb(body: RestoreDbRequest) {
    return this.request("/api/v1/db/restore", {
      method: "POST",
      body,
      schema: RestoreDbResponse,
    });
  }

  async listWebRepos() {
    return this.request("/api/v1/web/repos", { schema: WebListReposResponse });
  }

  async getWebRepoDetail(repoSlug: string) {
    return this.request(`/api/v1/web/repos/${encodeURIComponent(repoSlug)}`, {
      schema: WebRepoDetailResponse,
    });
  }

  async getWebRepoTree(repoSlug: string) {
    return this.request(`/api/v1/web/repos/${encodeURIComponent(repoSlug)}/tree`, {
      schema: WebRepoTreeResponse,
    });
  }

  async probeAddPath(body: { path: string }) {
    return this.request("/api/v1/web/repos/probe", {
      method: "POST",
      body,
      schema: AddFolderProbeResult,
    });
  }

  async addFolder(body: AddFolderRequest) {
    return this.request("/api/v1/web/repos/add", {
      method: "POST",
      body,
      schema: AddFolderResponse,
    });
  }

  async relinkClone(repoSlug: string, cloneId: string, body: RelinkCloneRequest) {
    return this.request(
      `/api/v1/web/repos/${encodeURIComponent(repoSlug)}/clones/${encodeURIComponent(cloneId)}`,
      {
        method: "PATCH",
        body,
      },
    );
  }

  async deleteClone(repoSlug: string, cloneId: string) {
    return this.request(
      `/api/v1/web/repos/${encodeURIComponent(repoSlug)}/clones/${encodeURIComponent(cloneId)}`,
      {
        method: "DELETE",
      },
    );
  }

  async archiveWorktree(repoSlug: string, body: ArchiveWorktreeRequest) {
    return this.request(`/api/v1/web/repos/${encodeURIComponent(repoSlug)}/worktrees/archive`, {
      method: "POST",
      body,
    });
  }

  async suggestConfig(body: ConfigSuggestRequest) {
    return this.request("/api/v1/web/config/suggest", {
      method: "POST",
      body,
      schema: ConfigSuggestResponse,
    });
  }

  async testConfig(body: ConfigTestRequest) {
    return this.request("/api/v1/web/config/test", {
      method: "POST",
      body,
      schema: ConfigTestResponse,
    });
  }

  async startConfigPreview(body: ConfigPreviewRequest) {
    return this.request("/api/v1/web/config/preview/start", {
      method: "POST",
      body,
      schema: ConfigPreviewResponse,
    });
  }

  async stopConfigPreview(body: ConfigPreviewStopRequest) {
    return this.request("/api/v1/web/config/preview/stop", {
      method: "POST",
      body,
    });
  }

  async saveConfig(body: ConfigSaveRequest) {
    return this.request("/api/v1/web/config/save", {
      method: "POST",
      body,
      schema: ConfigSaveResponse,
    });
  }

  getLogStreamUrl(
    repoId: string,
    envId: string,
    options: {
      service?: string;
      follow?: boolean;
      lines?: number;
      repoPath?: string;
    } = {},
  ) {
    return this.toUrl(
      this.withSearch(
        `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/logs`,
        {
          service: options.service,
          follow: stringifyOptional(options.follow),
          lines: stringifyOptional(options.lines),
          repoPath: options.repoPath,
        },
      ),
    );
  }

  // ─── Session API ─────────────────────────────────────────────────────────

  async listSessions() {
    return this.request("/api/v1/sessions", { schema: ListSessionsResponse });
  }

  async createSession(body: CreateSessionRequest) {
    return this.request("/api/v1/sessions", {
      method: "POST",
      body,
      schema: CreateSessionResponse,
    });
  }

  async getSession(sessionId: string) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      schema: SessionDetail,
    });
  }

  async deleteSession(sessionId: string) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async sendSessionMessage(sessionId: string, body: SendSessionMessageRequest) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body,
    });
  }

  async interruptSession(sessionId: string) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
    });
  }

  async *streamSessionEvents(sessionId: string, signal?: AbortSignal): AsyncIterable<SessionEventPayload> {
    const response = await this.fetchFn(
      this.toUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/events`),
      {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal,
      },
    );

    if (!response.ok || !response.body) {
      throw await this.toClientError(response);
    }

    yield* parseSSE(response.body, SessionEventPayload);
  }

  getEventsUrl(since?: number) {
    return this.toUrl(
      this.withSearch("/api/v1/events", {
        since: stringifyOptional(since),
      }),
    );
  }

  async *streamLogs(
    repoId: string,
    envId: string,
    services?: Array<string>,
    options?: {
      follow?: boolean;
      lines?: number;
      repoPath?: string;
    },
  ): AsyncIterable<LogLine> {
    const response = await this.fetchFn(
      this.getLogStreamUrl(repoId, envId, {
        service: services?.[0],
        follow: options?.follow,
        lines: options?.lines,
        repoPath: options?.repoPath,
      }),
      {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
    );

    const body = await this.requireEventStream(response);
    yield* parseSSE(body, LogLine);
  }

  async *streamEvents(since?: number): AsyncIterable<DomainEvent> {
    const response = await this.fetchFn(this.getEventsUrl(since), {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });

    const body = await this.requireEventStream(response);
    yield* parseSSE(body, DomainEvent);
  }

  private request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    },
  ): Promise<void>;
  private request<A extends Schema.Top>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      schema: A;
    },
  ): Promise<Schema.Schema.Type<A>>;
  private async request<A extends Schema.Top>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      schema?: A;
    },
  ): Promise<Schema.Schema.Type<A> | void> {
    const headers = Match.value(options.body).pipe(
      Match.when(undefined, () => ({})),
      Match.orElse(() => ({ "Content-Type": "application/json" })),
    ) satisfies Record<string, string>;

    const response = await this.fetchFn(this.toUrl(path), {
      method: options.method ?? "GET",
      headers,
      body: Match.value(options.body).pipe(
        Match.when(undefined, () => undefined),
        Match.orElse((value) => JSON.stringify(value)),
      ),
    });

    const successfulResponse = await Match.value(response.ok).pipe(
      Match.when(true, () => Promise.resolve(response)),
      Match.orElse(async () => {
        throw await this.toClientError(response);
      }),
    );

    return Option.fromUndefinedOr(options.schema).pipe(
      Option.match({
        onNone: () => undefined,
        onSome: (schema) =>
          Match.value(successfulResponse.status).pipe(
            Match.when(204, () => undefined),
            Match.orElse(async () => {
              const json = await successfulResponse.json();
              return decodeSchema(schema, json);
            }),
          ),
      }),
    );
  }

  private async toClientError(response: Response) {
    const fallback = new ApiClientError(response.status, response.statusText || "Request failed");
    const text = await response.text().catch(() => "");

    return Option.fromNullishOr(text).pipe(
      Option.filter((value) => value.length > 0),
      Option.flatMap(parseJsonText),
      Option.match({
        onNone: () => new ApiClientError(response.status, text || fallback.message),
        onSome: (json) =>
          decodeSchema(ApiError, json).then(
            (decoded) =>
              new ApiClientError(response.status, decoded.error, decoded.code, decoded.details),
            () => new ApiClientError(response.status, text || fallback.message),
          ),
      }),
    );
  }

  private toUrl(path: string) {
    if (!this.baseUrl) return path;
    // Concatenate so base URLs with a path prefix are preserved. For
    // example, when the federation host server sits at
    // `http://host/h/laptop`, using `new URL(path, baseUrl)` would
    // treat `/api/v1/daemon` as absolute and resolve to
    // `http://host/api/v1/daemon`, silently dropping `/h/laptop`.
    // Strip a trailing slash on the base to normalize, but otherwise
    // just string-concat.
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  private withSearch(path: string, params: Record<string, string | undefined>) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        search.set(key, value);
      }
    }
    const suffix = search.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  private async requireEventStream(response: Response) {
    return await Match.value({ ok: response.ok, body: response.body }).pipe(
      Match.when({ ok: true, body: Match.defined }, ({ body }) => Promise.resolve(body)),
      Match.orElse(async () => {
        throw await this.toClientError(response);
      }),
    );
  }
}

export function createApiClient(options?: ApiClientOptions) {
  return new ApiClient(options);
}

const parseJsonText = Option.liftThrowable((value: string): unknown => JSON.parse(value));
const stringifyOptional = (value: string | number | boolean | undefined) =>
  Match.value(value).pipe(
    Match.when(undefined, () => undefined),
    Match.orElse((current) => String(current)),
  );

async function decodeSchema<A extends Schema.Top>(schema: A, value: unknown) {
  return await (Schema.decodeUnknownPromise(schema as never)(value) as Promise<
    Schema.Schema.Type<A>
  >);
}

async function* parseSSE<A extends Schema.Top>(
  body: ReadableStream<Uint8Array>,
  schema: A,
): AsyncIterable<Schema.Schema.Type<A>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        const payload = getEventData(event);
        if (payload === undefined) {
          continue;
        }
        const parsed = JSON.parse(payload);
        yield await decodeSchema(schema, parsed);
      }
    }

    buffer += decoder.decode();
    const payload = getEventData(buffer);
    if (payload !== undefined) {
      yield await decodeSchema(schema, JSON.parse(payload));
    }
  } finally {
    reader.releaseLock();
  }
}

function getEventData(event: string) {
  const lines = event.split("\n");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data.length > 0 ? data : undefined;
}
