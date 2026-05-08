import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "spawntree-browser",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
