import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(root, "packages/core/src/generated");

rmSync(outputDir, { recursive: true, force: true });

execFileSync("go", ["run", "./cmd/openapi-gen"], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["exec", "openapi-ts", "-i", "openapi.yaml", "-o", outputDir, "-c", "@hey-api/client-fetch"], {
  cwd: root,
  stdio: "inherit",
});

fixGeneratedImports(outputDir);

function fixGeneratedImports(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      fixGeneratedImports(fullPath);
      continue;
    }
    if (extname(fullPath) !== ".ts") continue;
    let content = readFileSync(fullPath, "utf8");
    content = content.replace(
      /(from|export\s+\*\s+from)\s+['"](\.[^'"]+)['"]/g,
      (_match, prefix, specifier) => `${prefix} '${resolveSpecifier(fullPath, specifier)}'`,
    );
    writeFileSync(fullPath, content);
  }
}

function resolveSpecifier(file, specifier) {
  if (specifier.endsWith(".js") || specifier.endsWith(".json")) {
    return specifier;
  }
  const base = resolve(dirname(file), specifier);
  if (existsSync(`${base}.ts`)) {
    return `${specifier}.js`;
  }
  if (existsSync(join(base, "index.ts"))) {
    return `${specifier}/index.js`;
  }
  return `${specifier}.js`;
}
