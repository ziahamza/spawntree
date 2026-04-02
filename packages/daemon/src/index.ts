import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DaemonBinaryTarget {
  arch: string;
  ext: string;
  goArch: string;
  goOs: string;
  platform: NodeJS.Platform;
}

const SUPPORTED_TARGETS: DaemonBinaryTarget[] = [
  { platform: "darwin", arch: "x64", goOs: "darwin", goArch: "amd64", ext: "" },
  { platform: "darwin", arch: "arm64", goOs: "darwin", goArch: "arm64", ext: "" },
  { platform: "linux", arch: "x64", goOs: "linux", goArch: "amd64", ext: "" },
  { platform: "linux", arch: "arm64", goOs: "linux", goArch: "arm64", ext: "" },
  { platform: "win32", arch: "x64", goOs: "windows", goArch: "amd64", ext: ".exe" },
  { platform: "win32", arch: "arm64", goOs: "windows", goArch: "arm64", ext: ".exe" },
];

export function supportedDaemonBinaryTargets(): readonly DaemonBinaryTarget[] {
  return SUPPORTED_TARGETS;
}

export function daemonBinaryTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): DaemonBinaryTarget {
  const target = SUPPORTED_TARGETS.find((candidate) =>
    candidate.platform === platform && candidate.arch === arch,
  );

  if (!target) {
    throw new Error(`Unsupported daemon platform/arch: ${platform}/${arch}`);
  }

  return target;
}

export function daemonBinaryName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const target = daemonBinaryTarget(platform, arch);
  return `spawntreed-${target.goOs}-${target.goArch}${target.ext}`;
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
