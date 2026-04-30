import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "spawntree-daemon",
    include: ["tests/**/*.test.ts"],
    // Some daemon tests (dashboard-smoke, session-manager) spin up real
    // subprocesses or HTTP servers and consistently take 4-7s under
    // parallel load on CI. The default 5s timeout was causing
    // intermittent failures since the suite grew past ~150 tests.
    // 15s gives enough headroom without masking a real hang.
    testTimeout: 15_000,
  },
});
