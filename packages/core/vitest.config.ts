import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@spawntree/core",
    include: ["tests/**/*.test.ts"],
  },
});
