import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function spawntreeHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env["SPAWNTREE_HOME"] || env["SPAWNTREE_DATA_DIR"] || resolve(homedir(), ".spawntree"),
  );
}

export function localConfigPathForRepo(repoPath: string): string {
  const key = createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 12);
  return resolve(spawntreeHome(), "configs", `${key}.yaml`);
}
