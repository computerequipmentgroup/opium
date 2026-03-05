import { createApp } from "./app.js";
import { config } from "./config.js";
import { initDatabase } from "./db/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  logger.info("Starting Opium Proxy Server...");

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
