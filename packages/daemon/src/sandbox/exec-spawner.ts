import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Duplex, type Readable, type Writable } from "node:stream";
import type Dockerode from "dockerode";
import type { ProcessSpawner, SpawnOptions, SpawnedProcess } from "spawntree-core";

/**
 * `ProcessSpawner` implementations that run a command INSIDE a live sandbox
 * container. They produce a `SpawnedProcess` whose stdio is bridged to the
 * in-container process, so the ACP / JSON-RPC layer above is unaffected.
 *
 *   - Docker: dockerode `container.exec` + `exec.start({ hijack, stdin })`
 *     returns a single multiplexed duplex; we demux it into stdout/stderr.
 *   - Apple `container`: `container exec -i` is a plain child process whose
 *     stdio pipes already satisfy `SpawnedProcess` with no adaptation.
 *
 * Neither inherits the daemon's `process.env` — only `opts.env` crosses the
 * boundary (a security boundary, unlike the host spawner).
 */

/** The one `container.modem` method this file uses (its full type isn't exported). */
interface DemuxModem {
  demuxStream(
    stream: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
  ): void;
}

function toEnvArray(env: NodeJS.ProcessEnv | undefined): string[] {
  // Drop undefined-valued entries. The host spawner relies on Node treating
  // `undefined` as "unset" (e.g. the CLAUDECODE-unset markers); inside a
  // container we must omit them rather than set the literal string "undefined".
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v !== undefined) out.push(`${k}=${v}`);
  }
  return out;
}

// ─── Docker ────────────────────────────────────────────────────────────────

/**
 * Adapts a dockerode exec (hijacked duplex) to the `SpawnedProcess` shape the
 * transports consume. Exit code is recovered via `exec.inspect()` once the
 * stream closes; `kill()` closes stdin (EOF), which is how a stdio JSON-RPC
 * agent like claude-code-acp shuts down cleanly.
 */
class DockerExecProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly exec: Dockerode.Exec;
  private _exitCode: number | null = null;
  private killed = false;
  private closed = false;
  private readonly emitter = new EventEmitter();

  constructor(exec: Dockerode.Exec, stream: Duplex, modem: DemuxModem) {
    this.exec = exec;
    const out = new PassThrough();
    const err = new PassThrough();
    // Split the multiplexed attach stream into stdout/stderr (Tty:false above).
    modem.demuxStream(stream, out, err);
    this.stdin = stream;
    this.stdout = out;
    this.stderr = err;

    const onClose = () => {
      if (this.closed) return;
      this.closed = true;
      this.exec.inspect().then(
        (info) => this.finish(typeof info.ExitCode === "number" ? info.ExitCode : null),
        () => this.finish(this.killed ? 0 : null),
      );
    };
    stream.once("end", onClose);
    stream.once("close", onClose);
  }

  private finish(code: number | null): void {
    this._exitCode = code;
    this.emitter.emit("exit", code, null);
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    try {
      this.stdin.end();
    } catch {
      // already closed
    }
    return true;
  }

  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    this.emitter.on(event, listener);
    return this;
  }
}

export class DockerExecSpawner implements ProcessSpawner {
  readonly id: string;
  private readonly container: Dockerode.Container;

  constructor(container: Dockerode.Container, sandboxId: string) {
    this.container = container;
    this.id = `docker:${sandboxId}`;
  }

  async spawn(
    command: string,
    args: readonly string[],
    opts: SpawnOptions = {},
  ): Promise<SpawnedProcess> {
    const exec = await this.container.exec({
      Cmd: [command, ...args],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: toEnvArray(opts.env),
      ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
    });
    const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    return new DockerExecProcess(exec, stream, this.container.modem as DemuxModem);
  }
}

// ─── Apple `container` ───────────────────────────────────────────────────────

export class AppleContainerExecSpawner implements ProcessSpawner {
  readonly id: string;
  private readonly containerName: string;
  private readonly binary: string;

  constructor(containerName: string, binary: string, sandboxId: string) {
    this.containerName = containerName;
    this.binary = binary;
    this.id = `apple-container:${sandboxId}`;
  }

  spawn(command: string, args: readonly string[], opts: SpawnOptions = {}): SpawnedProcess {
    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      // Skip undefined (unset markers) — see toEnvArray rationale above.
      if (v !== undefined) envFlags.push("-e", `${k}=${v}`);
    }
    const cwdFlags = opts.cwd ? ["-w", opts.cwd] : [];
    // `container exec -i` keeps stdin open and gives clean stdout/stderr pipes;
    // the returned ChildProcess satisfies SpawnedProcess directly.
    return spawn(
      this.binary,
      ["exec", "-i", ...cwdFlags, ...envFlags, this.containerName, command, ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}
