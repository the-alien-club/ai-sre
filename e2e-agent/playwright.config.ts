import { defineConfig, devices } from "@playwright/test";

const ARTIFACT_DIR = process.env.TEST_ARTIFACT_DIR ?? "./data/artifacts";
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== "false";

export default defineConfig({
  testDir: "./tests",
  outputDir: `${ARTIFACT_DIR}/test-results`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Single worker by default — sub-agents run focused suites; parallelism is at the
  // sub-agent level, not the worker level. Override via --workers.
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: `${ARTIFACT_DIR}/last-run.json` }],
    ["html", { outputFolder: `${ARTIFACT_DIR}/html-report`, open: "never" }],
  ],
  use: {
    headless: HEADLESS,
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    // Always capture artifacts — Slack messages need them and the DB indexes them.
    screenshot: "on",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Add firefox/webkit projects when the regression suite needs cross-browser coverage.
  ],
});
