import { v4 as uuidv4 } from "uuid";
import { getDatabase } from "../db/index.js";
import { createChildLogger } from "../utils/logger.js";
import {
  generateApiKey,
  getApiKeyPrefix,
  hashApiKey,
  verifyApiKey,
} from "../utils/crypto.js";
import type { User, RegisterResponse, UserInfo, AccountInfo } from "../types/index.js";

const logger = createChildLogger("auth");

/**
 * Register a new user
 */
export async function registerUser(username: string): Promise<RegisterResponse> {
  const db = getDatabase();

  // Check if username already exists
  const existing = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(username) as { id: string } | undefined;

  if (existing) {
    throw new Error("Username already taken");
  }

  // Generate API key
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const apiKeyPrefix = getApiKeyPrefix(apiKey);
  const userId = uuidv4();

  // Insert user
  db.prepare(
    `INSERT INTO users (id, username, api_key_hash, api_key_prefix) VALUES (?, ?, ?, ?)`
  ).run(userId, username, apiKeyHash, apiKeyPrefix);

  logger.info({ userId, username }, "User registered");

  return {
    id: userId,
    username,
    api_key: apiKey, // Only returned once!
    has_account: false,
  };
}

/**
 * Authenticate user by API key
 */
export async function authenticateByApiKey(
  apiKey: string
): Promise<User | null> {
  const db = getDatabase();

  // Get prefix to narrow down search
  const prefix = getApiKeyPrefix(apiKey);

  // Find users with matching prefix
  const users = db
    .prepare("SELECT * FROM users WHERE api_key_prefix = ?")
    .all(prefix) as User[];

  // Verify against each potential match
  for (const user of users) {
    const isValid = await verifyApiKey(apiKey, user.api_key_hash);
    if (isValid) {
      // Update last seen
      db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(
        user.id
      );
      return user;
    }
  }

  return null;
}

/**
 * Get user by ID
 */
export function getUserById(userId: string): User | null {
  const db = getDatabase();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
    | User
    | undefined;
  return user || null;
}

/**
 * Regenerate API key for a user
 */
export async function regenerateApiKey(userId: string): Promise<string> {
  const db = getDatabase();

  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const apiKeyPrefix = getApiKeyPrefix(apiKey);

  db.prepare(
    "UPDATE users SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?"
  ).run(apiKeyHash, apiKeyPrefix, userId);

  logger.info({ userId }, "API key regenerated");

  return apiKey;
}

/**
 * Convert User to UserInfo (safe for client)
 */
export function toUserInfo(user: User): UserInfo {
  const hasAccount = user.access_token !== null;

  let account: AccountInfo | null = null;
  if (hasAccount) {
    account = {
      is_active: Boolean(user.is_active),
      share_limit_percent: user.share_limit_percent,
      usage: {
        usage_5h: user.usage_5h,
        usage_7d: user.usage_7d,
        reset_5h: user.reset_5h,
        reset_7d: user.reset_7d,
        updated_at: user.usage_updated_at,
      },
      is_rate_limited: Boolean(user.is_rate_limited),
      rate_limited_until: user.rate_limited_until,
    };
  }

  return {
    id: user.id,
    username: user.username,
    created_at: user.created_at,
    has_account: hasAccount,
    account,
  };
}
