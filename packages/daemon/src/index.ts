import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveServerEntry(): string {
  if (process.env.SPAWNTREE_DAEMON_ENTRY) {
    return process.env.SPAWNTREE_DAEMON_ENTRY;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "./server-main.js");
  if (existsSync(candidate)) {
    return candidate;
  }

  throw new Error(`Node daemon entrypoint not found at ${candidate}`);
}
