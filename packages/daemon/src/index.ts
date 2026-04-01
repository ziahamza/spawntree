import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function daemonBinaryName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const ext = platform === "win32" ? ".exe" : "";
  return `spawntreed-${platform}-${arch}${ext}`;
}

export function resolveDaemonBinary(): string {
  if (process.env.SPAWNTREE_DAEMON_BIN) {
    return process.env.SPAWNTREE_DAEMON_BIN;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../bin", daemonBinaryName());
  if (existsSync(candidate)) {
    return candidate;
  }

  throw new Error(`Native daemon binary not found for ${process.platform}/${process.arch} at ${candidate}`);
}
