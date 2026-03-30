import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@spawntree/cli",
    include: ["tests/**/*.test.ts"],
  },
});
