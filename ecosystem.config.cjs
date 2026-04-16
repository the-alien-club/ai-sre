// pm2 ecosystem config for the SRE agent
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs sre-agent
//   pm2 restart sre-agent
//   pm2 stop sre-agent

// Load .env into process env for pm2
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
      name: "sre-agent",
      script: "./scripts/start-agent.sh",
      args: [],
      interpreter: "bash",
      cwd: __dirname,

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 5000, // 5s between restarts

      // Logging
      error_file: "/var/log/sre-agent/error.log",
      out_file: "/var/log/sre-agent/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Environment — .env values merged with defaults
      env: {
        ...dotenv,
        SIGNOZ_WEBHOOK_PORT: dotenv.SIGNOZ_WEBHOOK_PORT || "8788",
        SIGNOZ_WEBHOOK_HOST: dotenv.SIGNOZ_WEBHOOK_HOST || "0.0.0.0",
        ESCALATION_INTERVAL_MS: dotenv.ESCALATION_INTERVAL_MS || "600000",
        DEV_ESCALATION_INTERVAL_MS: dotenv.DEV_ESCALATION_INTERVAL_MS || "3600000",
        NODE_ENV: "production",
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },

      // Resource limits (small VM)
      max_memory_restart: "1G",
    },
  ],
};
