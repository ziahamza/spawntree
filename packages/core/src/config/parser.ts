import { parse as parseYaml } from "yaml";
import { substituteVars } from "./substitution.js";

export interface ServiceConfig {
  type: "process" | "container" | "postgres" | "redis";
  command?: string;
  port?: number;
  image?: string;
  toolchain?: Record<string, string>;
  healthcheck?: {
    url: string;
    timeout?: number;
    interval?: number;
  };
  depends_on?: string[];
  environment?: Record<string, string>;
  fork_from?: string;
  volumes?: Array<{
    host: string;
    container: string;
    mode?: "ro" | "rw";
  }>;
}

export interface ProxyConfig {
  port: number;
}

export interface SpawntreeConfig {
  proxy?: ProxyConfig;
  services: Record<string, ServiceConfig>;
}

export function parseConfig(
  yamlContent: string,
  envVars: Record<string, string>,
): SpawntreeConfig {
  const raw = parseYaml(yamlContent) as Record<string, unknown>;
  const substituted = substituteVarsInObject(raw, envVars);
  return substituted as SpawntreeConfig;
}

function substituteVarsInObject(
  obj: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof obj === "string") {
    return substituteVars(obj, vars);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteVarsInObject(item, vars));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteVarsInObject(value, vars);
    }
    return result;
  }
  return obj;
}
