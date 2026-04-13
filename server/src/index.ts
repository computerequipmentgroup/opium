import { execFileSync } from "node:child_process";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { logger } from "./utils/logger.js";

const EXPECTED_CLAUDE_VERSION = "2.1.104";

/**
 * Fail-fast if the `claude` CLI is missing, broken, or a version we
 * haven't validated the stream-json format against. The binary path is
 * already resolved at config-load time; this just verifies it actually
 * runs and reports the pinned version.
 */
function checkClaudeCli(): void {
  let versionOutput: string;
  try {
    versionOutput = execFileSync(config.claudeBin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch (err) {
    throw new Error(
      `claude CLI at ${config.claudeBin} is not executable: ${(err as Error).message}`
    );
  }

  // Output looks like: "2.1.104 (Claude Code)"
  const match = versionOutput.match(/^([\d.]+)/);
  const actualVersion = match?.[1] ?? versionOutput;
  if (actualVersion !== EXPECTED_CLAUDE_VERSION) {
    logger.warn(
      { expected: EXPECTED_CLAUDE_VERSION, actual: actualVersion, bin: config.claudeBin },
      "claude CLI version does not match pinned version — stream-json format is undocumented and may drift"
    );
  } else {
    logger.info(
      { version: actualVersion, bin: config.claudeBin },
      "claude CLI health check ok"
    );
  }
}

async function main() {
  logger.info("Starting Opium Proxy Server...");

  // Verify CLI before touching anything else — a broken binary means every
  // /v1/messages request will fail, so there's no point booting.
  checkClaudeCli();

  // Initialize database
  initDatabase();

  // Create Express app
  const app = createApp();

  // Start server
  app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv },
      `Server running at http://localhost:${config.port}`
    );
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start server");
  process.exit(1);
});
