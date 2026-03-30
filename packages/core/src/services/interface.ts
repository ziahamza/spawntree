export type ServiceStatus = "starting" | "running" | "failed" | "stopped";

export interface Service {
  readonly name: string;
  readonly type: "process" | "container" | "postgres" | "redis";
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ServiceStatus;
  healthcheck?(): Promise<boolean>;
  logs?(): AsyncIterable<string>;
}
