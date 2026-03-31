import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const platform = process.platform;
const arch = process.arch;
const ext = platform === "win32" ? ".exe" : "";
const binDir = join(packageRoot, "bin");
const output = join(binDir, `spawntreed-${platform}-${arch}${ext}`);

mkdirSync(binDir, { recursive: true });
execFileSync("go", ["build", "-o", output, "./cmd/spawntreed"], {
  cwd: repoRoot,
  stdio: "inherit",
});
