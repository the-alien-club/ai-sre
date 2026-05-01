// pm2 ecosystem config for the E2E QA agent
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs e2e-agent
//   pm2 restart e2e-agent
//   pm2 stop e2e-agent

const { readFileSync } = require("fs");
const { join } = require("path");
const dotenv = {};
try {
  const envFile = readFileSync(join(__dirname, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    dotenv[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
} catch {}

module.exports = {
  apps: [
    {
      name: "e2e-agent",
      script: "./scripts/start-agent.sh",
      args: [],
      interpreter: "bash",
      cwd: __dirname,

      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 5000,

      error_file: "/var/log/e2e-agent/error.log",
      out_file: "/var/log/e2e-agent/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      env: {
        ...dotenv,
        GITLAB_WEBHOOK_PORT: dotenv.GITLAB_WEBHOOK_PORT || "8791",
        GITLAB_WEBHOOK_HOST: dotenv.GITLAB_WEBHOOK_HOST || "0.0.0.0",
        ESCALATION_INTERVAL_MS: dotenv.ESCALATION_INTERVAL_MS || "600000",
        DEV_ESCALATION_INTERVAL_MS: dotenv.DEV_ESCALATION_INTERVAL_MS || "3600000",
        PLAYWRIGHT_BROWSERS: dotenv.PLAYWRIGHT_BROWSERS || "chromium",
        PLAYWRIGHT_HEADLESS: dotenv.PLAYWRIGHT_HEADLESS || "true",
        TEST_ARTIFACT_DIR: dotenv.TEST_ARTIFACT_DIR || "./data/artifacts",
        NODE_ENV: "production",
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },

      // Playwright + Chromium are heavier than the SRE agent; bump the cap.
      max_memory_restart: "2G",
    },
  ],
};
