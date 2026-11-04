import { defineConfig } from "@playwright/test";

// End-to-end tests drive a real browser and are not part of `pnpm check`.
// Run them with `pnpm test:e2e` (first time: `pnpm test:e2e:install`).
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results",
  use: { browserName: "chromium", headless: true },
});
