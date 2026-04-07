import { config as dotenvConfig } from "dotenv";
import { expand } from "dotenv-expand";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface EnvLoadOptions {
  envName: string;
  configDir: string;
  cliOverrides?: Record<string, string>;
}

/**
 * Load environment variables with resolution order:
 * 1. .env (base defaults)
 * 2. .env.local (local overrides)
 * 3. .env.<envName> (per-environment overrides)
 * 4. CLI args (--env KEY=VALUE)
 * 5. Shell environment variables
 *
 * Uses dotenv with processEnv:{} to avoid polluting process.env.
 */
export function loadEnv(options: EnvLoadOptions): Record<string, string> {
  const { envName, configDir, cliOverrides } = options;
  const result: Record<string, string> = {};

  const envFiles = [
    resolve(configDir, ".env"),
    resolve(configDir, ".env.local"),
    resolve(configDir, `.env.${envName}`),
  ];

  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      const parsed = dotenvConfig({
        path: envFile,
        processEnv: result,
      });
      if (parsed.parsed) {
        expand({ parsed: parsed.parsed, processEnv: result });
      }
    }
  }

  if (cliOverrides) {
    Object.assign(result, cliOverrides);
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !(key in result)) {
      result[key] = value;
    }
  }

  return result;
}
