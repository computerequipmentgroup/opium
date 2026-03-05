import express, { type Express } from "express";
import cors from "cors";
import { config } from "./config.js";
import { createChildLogger } from "./utils/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import apiRouter from "./routes/api.js";
import proxyRouter from "./routes/proxy.js";

const logger = createChildLogger("app");

export function createApp(): Express {
  const app = express();

  // Request logging middleware
  if (config.enableRequestLogging) {
    app.use((req, _res, next) => {
      logger.info({ method: req.method, path: req.path }, "Incoming request");
      next();
    });
  }

  // CORS
  app.use(
    cors({
      origin: true, // Allow all origins in development, configure for production
      credentials: true,
    })
  );

  // Parse JSON bodies
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API routes
  app.use("/api/v1", apiRouter);

  // Proxy routes (Anthropic API)
  app.use("/v1", proxyRouter);

  // 404 handler
  app.use(notFoundHandler);

  // Error handler
  app.use(errorHandler);

  return app;
}
