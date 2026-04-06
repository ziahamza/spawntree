import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      resolve(__dirname, "packages/core/vitest.config.ts"),
      resolve(__dirname, "packages/daemon/vitest.config.ts"),
      resolve(__dirname, "packages/cli/vitest.config.ts"),
      resolve(__dirname, "packages/web/vitest.config.ts"),
    ],
  },
});
