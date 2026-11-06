import { defineConfig } from "vitest/config";

/**
 * The performance budget runs alone, after every other test file of `core`, in one worker: a
 * timed line that shares the CPUs with other test files measures them too (docs/design.md
 * section 15, "Core test approach").
 */
const BUDGET = "src/node/index-budget.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          include: ["src/**/*.test.ts"],
          exclude: [BUDGET],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "budget",
          include: [BUDGET],
          sequence: { groupOrder: 1 },
          maxWorkers: 1,
        },
      },
    ],
  },
});
