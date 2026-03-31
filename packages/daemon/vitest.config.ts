import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "spawntree-daemon",
    include: ["tests/**/*.test.ts"],
  },
});
