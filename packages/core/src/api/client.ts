import { createClient as createGeneratedClient } from "../generated/client/index.js";
import {
  createEnv,
  deleteEnv,
  downEnv,
  dumpDb,
  getDaemonInfo,
  getEnv,
  getInfraStatus,
  listDbTemplates,
  listEnvs,
  listRegisteredRepos,
  listRepoEnvs,
  listTunnelStatuses,
  listTunnels,
  registerRepo,
  restoreDb,
  stopInfra,
  upsertTunnel,
  type ApiError,
  type ClientOptions,
  type CreateEnvRequest,
  type CreateEnvResponse,
  type DaemonInfo,
  type DeleteEnvResponse,
  type DownEnvResponse,
  type DumpDbRequest,
  type DumpDbResponse,
  type EnvInfo,
  type GetEnvResponse,
  type InfraStatusResponse,
  type ListDbTemplatesResponse,
  type ListEnvsResponse,
  type ListRegisteredReposResponse,
  type ListTunnelStatusesResponse,
  type ListTunnelsResponse,
  type LogLine,
  type RegisterRepoRequest,
  type RegisterRepoResponse,
  type RestoreDbRequest,
  type RestoreDbResponse,
  type StopInfraRequest,
  type StopInfraResponse,
  type UpsertTunnelRequest,
  type UpsertTunnelResponse,
} from "../generated/index.js";

type GeneratedClient = ReturnType<typeof createGeneratedClient>;

export class ApiClient {
  private readonly client: GeneratedClient;

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly baseUrl: string,
  ) {
    this.client = createGeneratedClient({
      baseUrl,
      fetch: fetchFn,
      throwOnError: false,
      responseStyle: "fields",
    } satisfies ClientOptions & {
      fetch: typeof fetch;
      responseStyle: "fields";
      throwOnError: false;
    });
  }

  async getDaemonInfo(): Promise<DaemonInfo> {
    return this.unwrap(getDaemonInfo({ client: this.client }));
  }

  async createEnv(req: CreateEnvRequest): Promise<CreateEnvResponse> {
    return this.unwrap(createEnv({ client: this.client, body: req }));
  }

  async getEnv(repoId: string, envId: string): Promise<GetEnvResponse> {
    return this.unwrap(getEnv({ client: this.client, path: { repoId, envId } }));
  }

  async listEnvs(repoId?: string): Promise<ListEnvsResponse> {
    if (repoId) {
      const response = await this.unwrap<{ envs: EnvInfo[] }>(
        listRepoEnvs({ client: this.client, path: { repoId } }),
      );
      return { envs: response.envs };
    }
    return this.unwrap(listEnvs({ client: this.client }));
  }

  async deleteEnv(repoId: string, envId: string): Promise<DeleteEnvResponse> {
    return this.unwrap(deleteEnv({ client: this.client, path: { repoId, envId } }));
  }

  async downEnv(repoId: string, envId: string): Promise<DownEnvResponse> {
    return this.unwrap(downEnv({ client: this.client, path: { repoId, envId } }));
  }

  async registerRepo(req: RegisterRepoRequest): Promise<RegisterRepoResponse> {
    return this.unwrap(registerRepo({ client: this.client, body: req }));
  }

  async listRegisteredRepos(): Promise<ListRegisteredReposResponse> {
    return this.unwrap(listRegisteredRepos({ client: this.client }));
  }

  async listTunnels(): Promise<ListTunnelsResponse> {
    return this.unwrap(listTunnels({ client: this.client }));
  }

  async upsertTunnel(req: UpsertTunnelRequest): Promise<UpsertTunnelResponse> {
    return this.unwrap(upsertTunnel({ client: this.client, body: req }));
  }

  async listTunnelStatuses(): Promise<ListTunnelStatusesResponse> {
    return this.unwrap(listTunnelStatuses({ client: this.client }));
  }

  async *streamLogs(
    repoId: string,
    envId: string,
    services?: string[],
    options?: {
      follow?: boolean;
      lines?: number;
    },
  ): AsyncIterable<LogLine> {
    const url = new URL(
      `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/logs`,
      this.baseUrl,
    );

    if (services && services[0]) {
      url.searchParams.set("service", services[0]);
    }
    if (options?.follow === false) {
      url.searchParams.set("follow", "false");
    }
    if (options?.lines !== undefined) {
      url.searchParams.set("lines", String(options.lines));
    }

    const response = await this.fetchFn(url.toString(), {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new ApiClientError(response.status, `Log stream failed: ${text}`);
    }

    yield* parseSSE(response.body);
  }

  async getInfraStatus(): Promise<InfraStatusResponse> {
    return this.unwrap(getInfraStatus({ client: this.client }));
  }

  async stopInfra(req: StopInfraRequest): Promise<StopInfraResponse> {
    return this.unwrap(stopInfra({ client: this.client, body: req }));
  }

  async listDbTemplates(): Promise<ListDbTemplatesResponse> {
    return this.unwrap(listDbTemplates({ client: this.client }));
  }

  async dumpDb(req: DumpDbRequest): Promise<DumpDbResponse> {
    return this.unwrap(dumpDb({ client: this.client, body: req }));
  }

  async restoreDb(req: RestoreDbRequest): Promise<RestoreDbResponse> {
    return this.unwrap(restoreDb({ client: this.client, body: req }));
  }

  private async unwrap<T>(promise: Promise<any>): Promise<T> {
    const result = await promise;

    if (result?.response?.ok) {
      return result.data as T;
    }

    const statusCode = result?.response?.status ?? 500;
    const apiError = result?.error as ApiError | undefined;
    const message =
      apiError?.error ??
      result?.response?.statusText ??
      "Unknown error";

    throw new ApiClientError(
      statusCode,
      message,
      apiError?.code,
      apiError?.details,
    );
  }
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<LogLine> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        const parsed = parseSseEvent(event);
        if (parsed) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseSseEvent(buffer);
      if (parsed) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(event: string): LogLine | null {
  let dataLine: string | undefined;

  for (const line of event.split("\n")) {
    if (line.startsWith("data:")) {
      dataLine = line.slice(5).trimStart();
    }
  }

  if (!dataLine) return null;

  try {
    return JSON.parse(dataLine) as LogLine;
  } catch {
    return null;
  }
}

export class ApiClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}
