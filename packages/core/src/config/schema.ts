import type { SpawntreeConfig } from "./parser.js";

export interface ValidationError {
  path: string;
  message: string;
}

export function validateConfig(
  raw: unknown,
): { config: SpawntreeConfig; } | { errors: ValidationError[]; } {
  const errors: ValidationError[] = [];

  if (raw === null || typeof raw !== "object") {
    return { errors: [{ path: "", message: "Config must be an object" }] };
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.services || typeof obj.services !== "object") {
    return {
      errors: [{ path: "services", message: "services is required and must be an object" }],
    };
  }

  const services = obj.services as Record<string, unknown>;

  if (Object.keys(services).length === 0) {
    errors.push({ path: "services", message: "At least one service is required" });
  }

  const validTypes = new Set(["process", "container", "postgres", "redis", "external"]);

  for (const [name, svc] of Object.entries(services)) {
    if (svc === null || typeof svc !== "object") {
      errors.push({ path: `services.${name}`, message: "Service must be an object" });
      continue;
    }

    const service = svc as Record<string, unknown>;

    if (!service.type || typeof service.type !== "string") {
      errors.push({
        path: `services.${name}.type`,
        message: "type is required",
      });
    } else if (!validTypes.has(service.type)) {
      errors.push({
        path: `services.${name}.type`,
        message: `Unknown type "${service.type}". Valid types: ${[...validTypes].join(", ")}`,
      });
    }

    if (service.type === "process" && !service.command) {
      errors.push({
        path: `services.${name}.command`,
        message: "command is required for process services",
      });
    }

    if (service.type === "container" && !service.image) {
      errors.push({
        path: `services.${name}.image`,
        message: "image is required for container services",
      });
    }

    if (service.type === "external" && !service.url) {
      errors.push({
        path: `services.${name}.url`,
        message: "url is required for external services",
      });
    }

    if (service.volumes !== undefined) {
      if (!Array.isArray(service.volumes)) {
        errors.push({
          path: `services.${name}.volumes`,
          message: "volumes must be an array",
        });
      } else {
        for (let i = 0; i < service.volumes.length; i++) {
          const vol = service.volumes[i] as Record<string, unknown>;
          if (vol === null || typeof vol !== "object") {
            errors.push({
              path: `services.${name}.volumes[${i}]`,
              message: "Each volume entry must be an object",
            });
            continue;
          }
          if (typeof vol.host !== "string" || !vol.host) {
            errors.push({
              path: `services.${name}.volumes[${i}].host`,
              message: "host is required and must be a string",
            });
          }
          if (typeof vol.container !== "string" || !vol.container) {
            errors.push({
              path: `services.${name}.volumes[${i}].container`,
              message: "container is required and must be a string",
            });
          }
          if (vol.mode !== undefined && vol.mode !== "ro" && vol.mode !== "rw") {
            errors.push({
              path: `services.${name}.volumes[${i}].mode`,
              message: "mode must be \"ro\" or \"rw\"",
            });
          }
        }
      }
    }

    if (service.depends_on) {
      if (!Array.isArray(service.depends_on)) {
        errors.push({
          path: `services.${name}.depends_on`,
          message: "depends_on must be an array",
        });
      } else {
        for (const dep of service.depends_on) {
          if (typeof dep !== "string") {
            errors.push({
              path: `services.${name}.depends_on`,
              message: "depends_on entries must be strings",
            });
          } else if (!(dep in services)) {
            errors.push({
              path: `services.${name}.depends_on`,
              message: `Unknown dependency "${dep}"`,
            });
          }
        }
      }
    }
  }

  // Cycle detection
  const cycleError = detectCycles(services);
  if (cycleError) {
    errors.push({ path: "services", message: cycleError });
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { config: obj as unknown as SpawntreeConfig };
}

function detectCycles(services: Record<string, unknown>): string | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(name: string, path: string[]): string | null {
    if (inStack.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      return `Circular dependency detected: ${cycle.join(" → ")}`;
    }
    if (visited.has(name)) return null;

    visited.add(name);
    inStack.add(name);
    path.push(name);

    const svc = services[name] as Record<string, unknown> | undefined;
    const deps = (svc?.depends_on as string[]) || [];

    for (const dep of deps) {
      const result = dfs(dep, path);
      if (result) return result;
    }

    path.pop();
    inStack.delete(name);
    return null;
  }

  for (const name of Object.keys(services)) {
    const result = dfs(name, []);
    if (result) return result;
  }

  return null;
}
