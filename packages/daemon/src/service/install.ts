/**
 * `spawntree-daemon install` — register the daemon as a persistent OS service
 * so it runs in the background, starts at login/boot, and restarts on crash.
 * Removes the "run it in a terminal forever" friction on headless machines and
 * laptops that don't use the gitenv desktop app (which supervises its own
 * bundled daemon).
 *
 * Supported: macOS (launchd user agent) + Linux (systemd --user unit). The
 * service runs the daemon bare (`<node> server-main.js`); the daemon loads the
 * persisted host binding (`~/.spawntree/host.json`) on its own, so no
 * credential is baked into the service file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type HostBinding,
  hostBindingPath,
  loadHostBinding,
  saveHostBinding,
  spawntreeHome,
} from "../state/global-state.ts";

const LABEL = "dev.gitenv.spawntree-daemon";
const SYSTEMD_UNIT = "spawntree-daemon.service";

export type ServicePlatform = "darwin" | "linux";

export interface ServiceSpec {
  /** Absolute node binary that runs the daemon. */
  node: string;
  /** Absolute path to the daemon entry (`server-main.js`). */
  entry: string;
  /** spawntree home — used as the working dir + log location. */
  home: string;
}

/** Returns the current OS if supported, else throws with an actionable message. */
export function detectPlatform(): ServicePlatform {
  const p = platform();
  if (p === "darwin" || p === "linux") return p;
  throw new Error(
    `spawntree-daemon install: unsupported platform "${p}". Supported: macOS (launchd) and Linux (systemd --user). ` +
      `On other platforms, run \`spawntree-daemon\` under your own process manager.`,
  );
}

/** Absolute path to this package's `server-main.js` (the daemon entry). */
export function daemonEntryPath(): string {
  // At runtime this file is dist/service/install.js; server-main.js is dist/server-main.js.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "server-main.js");
}

export function launchdPlistPath(label: string = LABEL): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function systemdUnitPath(): string {
  return resolve(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** Render a launchd user-agent plist. Pure — unit-testable. */
export function renderLaunchdPlist(spec: ServiceSpec, label: string = LABEL): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(spec.node)}</string>
    <string>${esc(spec.entry)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${esc(spec.home)}</string>
  <key>StandardOutPath</key>
  <string>${esc(resolve(spec.home, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(resolve(spec.home, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

/** Render a systemd --user unit. Pure — unit-testable. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=spawntree daemon (gitenv)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${spec.node} ${spec.entry}
Restart=always
RestartSec=5
WorkingDirectory=${spec.home}

[Install]
WantedBy=default.target
`;
}

function currentSpec(): ServiceSpec {
  return { node: process.execPath, entry: daemonEntryPath(), home: spawntreeHome() };
}

/**
 * Persist a host binding from `--host`/`--host-key` flags if both are present,
 * so `install` can be a one-step `install --host … --host-key …`. Mirrors the
 * validation in server-main's `resolveHostBinding`.
 */
function maybeSaveBindingFromArgs(rest: ReadonlyArray<string>): void {
  const host = readFlag(rest, "--host");
  const key = readFlag(rest, "--host-key");
  if (!host && !key) return;
  if (!host || !key) {
    throw new Error("`--host` and `--host-key` must be passed together.");
  }
  if (!/^https?:\/\//.test(host)) {
    throw new Error(`--host must be an http(s) URL; got ${host}`);
  }
  if (!key.startsWith("dh_")) {
    throw new Error("--host-key must look like dh_<token>");
  }
  const binding: HostBinding = { url: host, key };
  saveHostBinding(binding);
}

function readFlag(argv: ReadonlyArray<string>, flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) return argv[i + 1] ?? null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

function requireBinding(): void {
  if (!loadHostBinding()) {
    throw new Error(
      `No host binding found at ${hostBindingPath()}. Run \`spawntree-daemon --host <url> --host-key <dh_…>\` once ` +
        "(or pass `--host`/`--host-key` to install) before installing the service.",
    );
  }
}

export function install(rest: ReadonlyArray<string> = []): void {
  const plat = detectPlatform();
  maybeSaveBindingFromArgs(rest);
  requireBinding();
  const spec = currentSpec();

  if (plat === "darwin") {
    const path = launchdPlistPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderLaunchdPlist(spec));
    // Reload idempotently: unload (ignore if not loaded), then load.
    try {
      execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
    } catch {
      // not loaded yet — fine
    }
    execFileSync("launchctl", ["load", "-w", path], { stdio: "inherit" });
    console.log(`spawntree-daemon: installed launchd agent → ${path}`);
    console.log(
      "It now runs at login and restarts on crash. Stop it with `spawntree-daemon uninstall`.",
    );
    return;
  }

  const path = systemdUnitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSystemdUnit(spec));
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "inherit" });
  // Keep the --user service running without an active login session (servers).
  try {
    execFileSync("loginctl", ["enable-linger", userInfo().username], { stdio: "ignore" });
  } catch {
    // enable-linger is best-effort; the service still runs while logged in.
  }
  console.log(`spawntree-daemon: installed systemd --user unit → ${path}`);
  console.log("Enabled + started, restarts on crash. Stop it with `spawntree-daemon uninstall`.");
}

export function uninstall(): void {
  const plat = detectPlatform();
  if (plat === "darwin") {
    const path = launchdPlistPath();
    if (existsSync(path)) {
      try {
        execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
      } catch {
        // not loaded — fine
      }
      rmSync(path);
      console.log(`spawntree-daemon: removed launchd agent ${path}`);
    } else {
      console.log("spawntree-daemon: no launchd agent installed.");
    }
    return;
  }

  const path = systemdUnitPath();
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
  } catch {
    // not enabled — fine
  }
  if (existsSync(path)) {
    rmSync(path);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    console.log(`spawntree-daemon: removed systemd --user unit ${path}`);
  } else {
    console.log("spawntree-daemon: no systemd unit installed.");
  }
}

export function status(): void {
  const plat = detectPlatform();
  if (plat === "darwin") {
    const path = launchdPlistPath();
    console.log(existsSync(path) ? `installed: ${path}` : "not installed");
    try {
      execFileSync("launchctl", ["list", LABEL], { stdio: "inherit" });
    } catch {
      console.log("(not currently loaded)");
    }
    return;
  }
  try {
    execFileSync("systemctl", ["--user", "status", SYSTEMD_UNIT, "--no-pager"], {
      stdio: "inherit",
    });
  } catch {
    console.log("not installed / not running");
  }
}

/**
 * Dispatch a service subcommand from `server-main`. Owns the error handling
 * (prints + sets a non-zero exit code) so `server-main.ts` — an Effect-linted
 * file that forbids try/catch — can call this with a bare `await`.
 */
export async function runServiceCommand(
  command: "install" | "uninstall" | "status",
  rest: ReadonlyArray<string>,
): Promise<void> {
  try {
    switch (command) {
      case "install":
        install(rest);
        return;
      case "uninstall":
        uninstall();
        return;
      case "status":
        status();
        return;
    }
  } catch (err) {
    process.stderr.write(
      `[spawntree-daemon] ${command} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
