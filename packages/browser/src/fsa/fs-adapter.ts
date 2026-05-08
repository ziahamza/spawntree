/**
 * Bridge from a browser `FileSystemDirectoryHandle` to a minimal
 * Node-like `fs.promises` shim that isomorphic-git can consume.
 *
 * Read paths supported: readFile, writeFile, unlink, readdir, mkdir,
 * rmdir, stat, lstat, readlink, symlink, chmod. The minimum surface
 * isomorphic-git needs.
 *
 * Modes:
 *   - `readonly` (default): writes throw. This enforces the "don't
 *     touch the working tree" invariant at the system boundary even if
 *     a buggy code path mistakenly calls `git.checkout` or similar.
 *
 *   - `fetchOnly`: writes are permitted ONLY under `.git/objects/`,
 *     `.git/refs/remotes/`, and `.git/packed-refs`. Any other write
 *     (notably HEAD, index, working tree) throws. Used by the pack
 *     fetch path so isomorphic-git can land a packfile and update
 *     remote-tracking refs without breaking the read-only invariant
 *     for the user's working state.
 *
 *   - `configWrite`: like `readonly`, but ALSO permits writes to the
 *     single allowed file path passed via `configWritePath`. Used by
 *     `SpawntreeBrowser.writeConfig` so the YAML config can be saved
 *     in-place without unlocking arbitrary writes elsewhere.
 *
 * Paths are POSIX-style absolute strings starting with `/`. The adapter
 * treats `/` as the root represented by the wrapped
 * `FileSystemDirectoryHandle`.
 */

export type AdapterMode = "readonly" | "fetchOnly" | "configWrite";

type Stats = {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  uid: number;
  gid: number;
  dev: number;
  ctimeMs: number;
  mtimeMs: number;
  ctimeSeconds: number;
  ctimeNanoseconds: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export type IsoFsPromises = {
  readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string>;
  writeFile(
    path: string,
    data: Uint8Array | string,
    options?: { encoding?: string } | string,
  ): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
};

export type IsoFs = { promises: IsoFsPromises };

export type CreateFsOptions = {
  mode?: AdapterMode;
  /**
   * Absolute path (starting with `/`) inside the wrapped root that is
   * permitted to be written when `mode === "configWrite"`. Ignored in
   * other modes. Required if mode is `configWrite`.
   */
  configWritePath?: string;
};

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

function makeStats(kind: "file" | "dir", size: number): Stats {
  return {
    type: kind,
    mode: kind === "dir" ? 0o755 : 0o644,
    size,
    ino: 0,
    uid: 0,
    gid: 0,
    dev: 0,
    ctimeMs: 0,
    mtimeMs: 0,
    ctimeSeconds: 0,
    ctimeNanoseconds: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
  };
}

class ENOENT extends Error {
  code = "ENOENT";
  constructor(path: string) {
    super(`ENOENT: no such file or directory, ${path}`);
  }
}

class EISDIR extends Error {
  code = "EISDIR";
  constructor(path: string) {
    super(`EISDIR: illegal operation on a directory, ${path}`);
  }
}

class EACCES extends Error {
  code = "EACCES";
  constructor(path: string, reason: string) {
    super(`EACCES: ${reason}: ${path}`);
  }
}

function splitPath(path: string): string[] {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
}

function joinPath(parts: string[]): string {
  return `/${parts.join("/")}`;
}

async function getDir(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === "NotFoundError" || e.name === "TypeMismatchError") {
        throw new ENOENT(`/${parts.join("/")}`);
      }
      throw err;
    }
  }
  return dir;
}

async function getFile(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create = false,
): Promise<FileSystemFileHandle> {
  if (parts.length === 0) throw new EISDIR("/");
  const parent = await getDir(root, parts.slice(0, -1), create);
  const name = parts[parts.length - 1];
  if (!name) throw new EISDIR(`/${parts.join("/")}`);
  try {
    return await parent.getFileHandle(name, { create });
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === "NotFoundError") throw new ENOENT(`/${parts.join("/")}`);
    if (e.name === "TypeMismatchError") throw new EISDIR(`/${parts.join("/")}`);
    throw err;
  }
}

function isWriteAllowed(
  mode: AdapterMode,
  configWritePath: string | undefined,
  parts: string[],
): boolean {
  if (mode === "readonly") return false;
  if (mode === "configWrite") {
    // Only permit writes to the exact configured filename.
    if (!configWritePath) return false;
    const targetParts = splitPath(configWritePath);
    if (targetParts.length !== parts.length) return false;
    for (let i = 0; i < targetParts.length; i++) {
      if (targetParts[i] !== parts[i]) return false;
    }
    return true;
  }
  // fetchOnly: allow writes inside .git/objects/, .git/refs/remotes/,
  // .git/packed-refs. Find a `.git` segment anywhere in the path
  // (handles both repo and worktree gitdirs).
  const idx = parts.findIndex((p) => p === ".git" || p.endsWith(".git"));
  if (idx < 0) return false;
  const after = parts.slice(idx + 1);
  if (after.length === 0) return false;
  if (after[0] === "objects") return true;
  if (after[0] === "refs" && after[1] === "remotes") return true;
  if (after[0] === "packed-refs") return true;
  return false;
}

export function createFsFromHandle(
  rootHandle: FileSystemDirectoryHandle,
  options: AdapterMode | CreateFsOptions = "readonly",
): IsoFs {
  const opts: CreateFsOptions = typeof options === "string" ? { mode: options } : options;
  const mode: AdapterMode = opts.mode ?? "readonly";
  const configWritePath = opts.configWritePath;

  const promises: IsoFsPromises = {
    async readFile(path, options) {
      const parts = splitPath(path);
      const handle = await getFile(rootHandle, parts, false);
      const file = await handle.getFile();
      const buffer = new Uint8Array(await file.arrayBuffer());
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (encoding === "utf8" || encoding === "utf-8") {
        return TEXT_DECODER.decode(buffer);
      }
      return buffer;
    },

    async writeFile(path, data, options) {
      const parts = splitPath(path);
      if (!isWriteAllowed(mode, configWritePath, parts)) {
        throw new EACCES(joinPath(parts), "writes are disabled in this mode");
      }
      const handle = await getFile(rootHandle, parts, true);
      // FileSystemFileHandle.createWritable requires a permission grant.
      const writable = await handle.createWritable();
      try {
        const encoding = typeof options === "string" ? options : options?.encoding;
        if (typeof data === "string") {
          if (encoding === "utf8" || encoding === "utf-8" || encoding === undefined) {
            await writable.write(TEXT_ENCODER.encode(data) as unknown as FileSystemWriteChunkType);
          } else {
            await writable.write(data as unknown as FileSystemWriteChunkType);
          }
        } else {
          await writable.write(data as unknown as FileSystemWriteChunkType);
        }
      } finally {
        await writable.close();
      }
    },

    async unlink(path) {
      const parts = splitPath(path);
      if (!isWriteAllowed(mode, configWritePath, parts)) {
        throw new EACCES(joinPath(parts), "writes are disabled in this mode");
      }
      const parent = await getDir(rootHandle, parts.slice(0, -1));
      const name = parts[parts.length - 1];
      if (!name) throw new ENOENT(joinPath(parts));
      await parent.removeEntry(name);
    },

    async readdir(path) {
      const parts = splitPath(path);
      const dir = await getDir(rootHandle, parts);
      const out: string[] = [];
      // FileSystemDirectoryHandle is async-iterable in modern browsers.
      for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        out.push(name);
      }
      return out;
    },

    async mkdir(path, options) {
      const parts = splitPath(path);
      if (!isWriteAllowed(mode, configWritePath, parts)) {
        throw new EACCES(joinPath(parts), "writes are disabled in this mode");
      }
      if (options?.recursive) {
        await getDir(rootHandle, parts, true);
      } else {
        const parent = await getDir(rootHandle, parts.slice(0, -1));
        const name = parts[parts.length - 1];
        if (!name) throw new ENOENT(joinPath(parts));
        await parent.getDirectoryHandle(name, { create: true });
      }
    },

    async rmdir(path) {
      const parts = splitPath(path);
      if (!isWriteAllowed(mode, configWritePath, parts)) {
        throw new EACCES(joinPath(parts), "writes are disabled in this mode");
      }
      const parent = await getDir(rootHandle, parts.slice(0, -1));
      const name = parts[parts.length - 1];
      if (!name) throw new ENOENT(joinPath(parts));
      await parent.removeEntry(name);
    },

    async stat(path) {
      return promises.lstat(path);
    },

    async lstat(path) {
      const parts = splitPath(path);
      if (parts.length === 0) {
        return makeStats("dir", 0);
      }
      const parent = await getDir(rootHandle, parts.slice(0, -1));
      const name = parts[parts.length - 1];
      if (!name) throw new ENOENT(joinPath(parts));
      // Try as directory first; fall back to file. We can't tell from
      // the parent without trying both — getDirectoryHandle /
      // getFileHandle are the only enumeration entry points.
      try {
        await parent.getDirectoryHandle(name);
        return makeStats("dir", 0);
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === "TypeMismatchError") {
          // It exists, but as a file.
        } else if (e.name !== "NotFoundError") {
          throw err;
        }
      }
      try {
        const fh = await parent.getFileHandle(name);
        const f = await fh.getFile();
        return makeStats("file", f.size);
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === "NotFoundError" || e.name === "TypeMismatchError") {
          throw new ENOENT(joinPath(parts));
        }
        throw err;
      }
    },

    async readlink(path) {
      // FSA does not expose symlink targets; treat as missing.
      throw new ENOENT(path);
    },

    async symlink(_target, path) {
      throw new EACCES(path, "symlinks are not supported in the FSA adapter");
    },

    async chmod(_path, _mode) {
      // Permissions are not exposed via FSA — silently ignore.
    },
  };

  return { promises };
}
