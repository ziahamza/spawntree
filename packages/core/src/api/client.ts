import type {
  DaemonInfo,
  CreateEnvRequest,
  CreateEnvResponse,
  GetEnvResponse,
  ListEnvsResponse,
  DeleteEnvResponse,
  DownEnvResponse,
  LogLine,
  GetInfraStatusResponse,
  StopInfraRequest,
  StopInfraResponse,
  ListDbTemplatesResponse,
  DumpDbRequest,
  DumpDbResponse,
  RestoreDbRequest,
  RestoreDbResponse,
  ApiError,
} from "./types.js";

export class ApiClient {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly baseUrl: string,
  ) {}

  // -------------------------------------------------------------------------
  // Daemon
  // -------------------------------------------------------------------------

  async getDaemonInfo(): Promise<DaemonInfo> {
    return this.get<DaemonInfo>("/api/v1/daemon");
  }

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------

  async createEnv(req: CreateEnvRequest): Promise<CreateEnvResponse> {
    return this.post<CreateEnvResponse>("/api/v1/envs", req);
  }

  async getEnv(repoId: string, envId: string): Promise<GetEnvResponse> {
    return this.get<GetEnvResponse>(`/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}`);
  }

  async listEnvs(repoId?: string): Promise<ListEnvsResponse> {
    const path = repoId
      ? `/api/v1/repos/${encodeURIComponent(repoId)}/envs`
      : "/api/v1/envs";
    return this.get<ListEnvsResponse>(path);
  }

  async deleteEnv(repoId: string, envId: string): Promise<DeleteEnvResponse> {
    return this.delete<DeleteEnvResponse>(
      `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}`,
    );
  }

  async downEnv(repoId: string, envId: string): Promise<DownEnvResponse> {
    return this.post<DownEnvResponse>(
      `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/down`,
      {},
    );
  }

  // -------------------------------------------------------------------------
  // Log streaming (SSE)
  // -------------------------------------------------------------------------

  async *streamLogs(
    repoId: string,
    envId: string,
    services?: string[],
  ): AsyncIterable<LogLine> {
    const url = new URL(
      `/api/v1/repos/${encodeURIComponent(repoId)}/envs/${encodeURIComponent(envId)}/logs`,
      this.baseUrl,
    );

    if (services && services.length > 0) {
      for (const svc of services) {
        url.searchParams.append("service", svc);
      }
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

  // -------------------------------------------------------------------------
  // Infrastructure
  // -------------------------------------------------------------------------

  async getInfraStatus(): Promise<GetInfraStatusResponse> {
    return this.get<GetInfraStatusResponse>("/api/v1/infra");
  }

  async stopInfra(req: StopInfraRequest): Promise<StopInfraResponse> {
    return this.post<StopInfraResponse>("/api/v1/infra/stop", req);
  }

  // -------------------------------------------------------------------------
  // DB templates
  // -------------------------------------------------------------------------

  async listDbTemplates(): Promise<ListDbTemplatesResponse> {
    return this.get<ListDbTemplatesResponse>("/api/v1/db/templates");
  }

  async dumpDb(req: DumpDbRequest): Promise<DumpDbResponse> {
    return this.post<DumpDbResponse>("/api/v1/db/dump", req);
  }

  async restoreDb(req: RestoreDbRequest): Promise<RestoreDbResponse> {
    return this.post<RestoreDbResponse>("/api/v1/db/restore", req);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return this.parseResponse<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response);
  }

  private async delete<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const text = await response.text();

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiClientError(response.status, `Non-JSON response: ${text}`);
    }

    if (!response.ok) {
      const err = json as ApiError;
      throw new ApiClientError(
        response.status,
        err.error ?? "Unknown error",
        err.code,
        err.details,
      );
    }

    return json as T;
  }
}

// -------------------------------------------------------------------------
// SSE parser
// -------------------------------------------------------------------------

/**
 * Parse a ReadableStream of SSE events into LogLine objects.
 * Handles `data:` lines; ignores comments and keep-alive lines.
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<LogLine> {
  const decoder = new TextDecoder();
  const reader = body.getReader();

  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const events = buffer.split(/\n\n/);
      // Keep the last (potentially incomplete) chunk in the buffer
      buffer = events.pop() ?? "";

      for (const event of events) {
        const logLine = parseSseEvent(event);
        if (logLine !== null) {
          yield logLine;
        }
      }
    }

    // Flush any remaining data
    buffer += decoder.decode();
    if (buffer.trim()) {
      const logLine = parseSseEvent(buffer);
      if (logLine !== null) {
        yield logLine;
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
    // Ignore `id:`, `event:`, `retry:`, and comment lines
  }

  if (dataLine === undefined || dataLine === "") return null;

  try {
    return JSON.parse(dataLine) as LogLine;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Error type
// -------------------------------------------------------------------------

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
