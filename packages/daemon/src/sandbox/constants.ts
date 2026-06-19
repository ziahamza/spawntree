import type { BindMount, SandboxSpec } from "spawntree-core";

/**
 * Shared sandbox runtime conventions. Container labels let the daemon
 * rediscover sandboxes it manages (for `adopt`/`list`/GC) after a restart,
 * mirroring the `spawntree.*` label scheme `DockerRunner` already uses for
 * service containers.
 */

/** Default OCI image with node + git + a baked agent CLI (see sandbox-image/). */
export const DEFAULT_SANDBOX_IMAGE = "ghcr.io/ziahamza/spawntree-sandbox:latest";

export const LABEL_MANAGED = "spawntree.managed";
export const LABEL_KIND = "spawntree.kind";
export const LABEL_SANDBOX_ID = "spawntree.sandboxId";
export const LABEL_REPO_ID = "spawntree.repoId";
export const LABEL_EPHEMERAL = "spawntree.ephemeral";
export const LABEL_WORKSPACE_MODE = "spawntree.workspaceMode";

/** Value of LABEL_KIND identifying a sandbox (vs. a service container). */
export const SANDBOX_KIND = "sandbox";

/** Runtime container name for a sandbox id. Stable, so CLI runtimes can target by name. */
export function containerNameFor(sandboxId: string): string {
  return `spawntree-${sandboxId}`;
}

/** ISO-8601 UTC timestamp, matching the catalog's text-timestamp convention. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The bind mounts a sandbox needs for its workspace. In `mount` mode the
 * worktree is mounted at an IDENTICAL host/container path (load-bearing — see
 * WorkspaceSpec). `clone` mode adds no mount (the repo is cloned inside).
 */
export function resolveWorkspaceMounts(spec: SandboxSpec): BindMount[] {
  const mounts: BindMount[] = [];
  if (spec.workspace.mode === "mount") {
    mounts.push({
      host: spec.workspace.worktreePath,
      container: spec.workspace.worktreePath,
      mode: "rw",
    });
  }
  for (const m of spec.extraMounts ?? []) mounts.push(m);
  return mounts;
}

/** The spawntree.* labels plus any user labels, stamped on the runtime container. */
export function buildSandboxLabels(id: string, spec: SandboxSpec): Record<string, string> {
  return {
    [LABEL_MANAGED]: "true",
    [LABEL_KIND]: SANDBOX_KIND,
    [LABEL_SANDBOX_ID]: id,
    [LABEL_WORKSPACE_MODE]: spec.workspace.mode,
    [LABEL_EPHEMERAL]: spec.ephemeral ? "true" : "false",
    ...(spec.repoId ? { [LABEL_REPO_ID]: spec.repoId } : {}),
    ...spec.labels,
  };
}
