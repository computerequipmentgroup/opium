import pino from "pino";
import { config, isDevelopment } from "../config.js";

export const logger = pino({
  level: config.logLevel,
  transport: isDevelopment()
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
