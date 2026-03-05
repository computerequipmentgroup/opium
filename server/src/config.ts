import { config as dotenvConfig } from "dotenv";
import type { ServerConfig } from "./types/index.js";

dotenvConfig();

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer`);
  }
  return parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === "true" || value === "1";
}

export const config: ServerConfig = {
  port: getEnvInt("PORT", 8082),
  nodeEnv: getEnv("NODE_ENV", "development"),
  databasePath: getEnv("DATABASE_PATH", "./data/opium.db"),
  encryptionKey: getEnv(
    "ENCRYPTION_KEY",
    "dev-key-do-not-use-in-production-!!"
  ),
  apiKeySaltRounds: getEnvInt("API_KEY_SALT_ROUNDS", 12),
  adminApiKey: getEnv("ADMIN_API_KEY"),
  anthropicClientId: getEnv(
    "ANTHROPIC_CLIENT_ID",
    "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
  ),
  anthropicRedirectUri: getEnv(
    "ANTHROPIC_REDIRECT_URI",
    "https://console.anthropic.com/oauth/code/callback"
  ),
  logLevel: getEnv("LOG_LEVEL", "info"),
  enableRequestLogging: getEnvBool("ENABLE_REQUEST_LOGGING", false),
};

export function isDevelopment(): boolean {
  return config.nodeEnv === "development";
}

export function isProduction(): boolean {
  return config.nodeEnv === "production";
}
