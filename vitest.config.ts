import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    projects: [
      resolve(__dirname, "packages/core/vitest.config.ts"),
      resolve(__dirname, "packages/daemon/vitest.config.ts"),
      resolve(__dirname, "packages/cli/vitest.config.ts"),
    ],
  },
});
