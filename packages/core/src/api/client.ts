import { Schema } from "effect";
import {
  AddFolderProbeResult,
  AddFolderResponse,
  ApiError,
  ConfigPreviewResponse,
  ConfigSaveResponse,
  ConfigSuggestResponse,
  ConfigTestResponse,
  CreateEnvResponse,
  DaemonInfo,
  DomainEvent,
  DumpDbResponse,
  GetEnvResponse,
  InfraStatusResponse,
  ListEnvsResponse,
  LogLine,
  RegisterRepoResponse,
  RestoreDbResponse,
  WebListReposResponse,
  WebRepoDetailResponse,
} from "./schemas.js";
import type {
  AddFolderRequest,
  ArchiveWorktreeRequest,
  ConfigPreviewRequest,
  ConfigPreviewStopRequest,
  ConfigSaveRequest,
  ConfigSuggestRequest,
  ConfigTestRequest,
  CreateEnvRequest,
  DumpDbRequest,
  RegisterRepoRequest,
  RelinkCloneRequest,
  RestoreDbRequest,
  StopInfraRequest,
} from "./types.js";

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
    const path = repoId ? `/api/v1/repos/${encodeURIComponent(repoId)}/envs` : "/api/v1/envs";
    return this.request(path, { schema: ListEnvsResponse });
  }

  async getEnv(repoId: string, envId: string, repoPath?: string) {
    return this.request(
      this.withSearch(`/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}`, {
        repoPath,
      }),
      { schema: GetEnvResponse },
    );
  }

  async downEnv(repoId: string, envId: string, repoPath?: string) {
    return this.request(
      this.withSearch(`/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/down`, {
        repoPath,
      }),
      { method: "POST" },
    );
  }

  async deleteEnv(repoId: string, envId: string, repoPath?: string) {
    return this.request(
      this.withSearch(`/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}`, {
        repoPath,
      }),
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

  async probeAddPath(body: { path: string; }) {
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
    return this.request(`/api/v1/web/repos/${encodeURIComponent(repoSlug)}/clones/${encodeURIComponent(cloneId)}`, {
      method: "PATCH",
      body,
    });
  }

  async deleteClone(repoSlug: string, cloneId: string) {
    return this.request(`/api/v1/web/repos/${encodeURIComponent(repoSlug)}/clones/${encodeURIComponent(cloneId)}`, {
      method: "DELETE",
    });
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
      this.withSearch(`/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/logs`, {
        service: options.service,
        follow: options.follow === undefined ? undefined : String(options.follow),
        lines: options.lines === undefined ? undefined : String(options.lines),
        repoPath: options.repoPath,
      }),
    );
  }

  getEventsUrl(since?: number) {
    return this.toUrl(this.withSearch("/api/v1/events", {
      since: since === undefined ? undefined : String(since),
    }));
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

    if (!response.ok || !response.body) {
      throw await this.toClientError(response);
    }

    yield* parseSSE(response.body, LogLine);
  }

  async *streamEvents(since?: number): AsyncIterable<DomainEvent> {
    const response = await this.fetchFn(this.getEventsUrl(since), {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });

    if (!response.ok || !response.body) {
      throw await this.toClientError(response);
    }

    yield* parseSSE(response.body, DomainEvent);
  }

  private request(path: string, options: {
    method?: string;
    body?: unknown;
  }): Promise<void>;
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
    const response = await this.fetchFn(this.toUrl(path), {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      throw await this.toClientError(response);
    }

    if (options.schema === undefined || response.status === 204) {
      return;
    }

    const json = await response.json();
    return await decodeSchema(options.schema, json);
  }

  private async toClientError(response: Response) {
    const fallback = new ApiClientError(response.status, response.statusText || "Request failed");
    try {
      const json = await response.json();
      const decoded = await decodeSchema(ApiError, json);
      return new ApiClientError(response.status, decoded.error, decoded.code, decoded.details);
    } catch {
      const text = await response.text().catch(() => "");
      return new ApiClientError(response.status, text || fallback.message);
    }
  }

  private toUrl(path: string) {
    if (!this.baseUrl) return path;
    return new URL(path, this.baseUrl).toString();
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
}

export function createApiClient(options?: ApiClientOptions) {
  return new ApiClient(options);
}

async function decodeSchema<A extends Schema.Top>(schema: A, value: unknown) {
  return await (Schema.decodeUnknownPromise(schema as never)(value) as Promise<Schema.Schema.Type<A>>);
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
        const parsed = JSON.parse(payload) as unknown;
        yield await decodeSchema(schema, parsed);
      }
    }

    buffer += decoder.decode();
    const payload = getEventData(buffer);
    if (payload !== undefined) {
      yield await decodeSchema(schema, JSON.parse(payload) as unknown);
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
