import { config as dotenvConfig } from "dotenv";
import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./types/index.js";

dotenvConfig();

/**
 * Resolve the `claude` CLI binary.
 * Priority: CLAUDE_BIN env var > well-known paths > `which claude`.
 * Throws if not found — failing at startup beats failing mid-request.
 */
function resolveClaudeBin(): string {
  const envBin = process.env.CLAUDE_BIN;
  if (envBin) {
    try {
      accessSync(envBin, constants.X_OK);
      return envBin;
    } catch {
      throw new Error(`CLAUDE_BIN="${envBin}" is set but not executable`);
    }
  }

  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    join(process.env.HOME || "", ".local/bin/claude"),
  ];
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }

  try {
    const resolved = execFileSync("which", ["claude"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (resolved) return resolved;
  } catch {
    /* fall through */
  }

  throw new Error(
    "claude binary not found. Set CLAUDE_BIN=/path/to/claude or ensure claude is on PATH."
  );
}

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
  claudeHomeRoot: getEnv("OPIUM_HOME_ROOT", join(homedir(), ".opium", "accounts")),
  claudeBin: resolveClaudeBin(),
  claudeMaxConcurrent: getEnvInt("CLAUDE_MAX_CONCURRENT", 8),
  claudeTimeoutMs: getEnvInt("CLAUDE_TIMEOUT_MS", 600_000),
  claudeSessionTtlMs: getEnvInt("CLAUDE_SESSION_TTL_MS", 3_600_000),
};

export function isDevelopment(): boolean {
  return config.nodeEnv === "development";
}

export function isProduction(): boolean {
  return config.nodeEnv === "production";
}
