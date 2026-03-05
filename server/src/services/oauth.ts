import { createHash, randomBytes } from "crypto";
import { getDatabase } from "../db/index.js";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import type { OAuthTokens } from "../types/index.js";

const logger = createChildLogger("oauth");

// Anthropic OAuth configuration
const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const SCOPES = "org:create_api_key user:profile user:inference";

/**
 * Generate a cryptographically secure random string for PKCE
 */
function generateRandomString(length: number): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset[randomValues[i]! % charset.length];
  }
  return result;
}

/**
 * Generate code challenge from code verifier (S256 method)
 */
function generateCodeChallenge(codeVerifier: string): string {
  const hash = createHash("sha256").update(codeVerifier).digest();
  return hash.toString("base64url");
}

/**
 * Start OAuth flow for a user
 * Returns the authorization URL and state
 */
export function startOAuthFlow(userId: string): { authUrl: string; state: string } {
  const db = getDatabase();

  // Generate PKCE code verifier (also used as state)
  const codeVerifier = generateRandomString(64);
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Clean up any existing sessions for this user
  db.prepare("DELETE FROM oauth_sessions WHERE user_id = ?").run(userId);

  // Store the pending session
  db.prepare(
    "INSERT INTO oauth_sessions (state, user_id, code_verifier) VALUES (?, ?, ?)"
  ).run(codeVerifier, userId, codeVerifier);

  // Build the authorization URL
  const params = new URLSearchParams({
    code: "true", // Manual code entry mode
    client_id: config.anthropicClientId,
    response_type: "code",
    redirect_uri: config.anthropicRedirectUri,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: codeVerifier,
  });

  const authUrl = `${AUTH_URL}?${params.toString()}`;

  logger.info({ userId }, "OAuth flow started");

  return { authUrl, state: codeVerifier };
}

/**
 * Complete OAuth flow by exchanging the authorization code for tokens
 */
export async function completeOAuthFlow(
  userId: string,
  code: string,
  state: string
): Promise<OAuthTokens> {
  const db = getDatabase();

  // Retrieve the pending session
  const session = db
    .prepare(
      "SELECT * FROM oauth_sessions WHERE state = ? AND user_id = ?"
    )
    .get(state, userId) as { code_verifier: string } | undefined;

  if (!session) {
    throw new Error("Invalid or expired OAuth session");
  }

  // Delete the session
  db.prepare("DELETE FROM oauth_sessions WHERE state = ?").run(state);

  // Exchange the code for tokens
  const tokens = await exchangeCodeForTokens(code, session.code_verifier);

  // Calculate expiration time
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Encrypt and store tokens in user record
  const encryptedAccessToken = encrypt(tokens.access_token);
  const encryptedRefreshToken = encrypt(tokens.refresh_token);

  const updateResult = db.prepare(
    `UPDATE users SET 
      access_token = ?, 
      refresh_token = ?, 
      token_expires_at = ?,
      is_active = 1
    WHERE id = ?`
  ).run(encryptedAccessToken, encryptedRefreshToken, expiresAt, userId);

  logger.info({ userId, changes: updateResult.changes }, "OAuth flow completed, account linked");
  
  // Verify the update
  const verifyUser = db.prepare("SELECT id, username, access_token IS NOT NULL as has_token, is_active FROM users WHERE id = ?").get(userId);
  logger.info({ userId, verifyUser }, "Verified user state after OAuth");

  return tokens;
}

/**
 * Exchange authorization code for tokens (with PKCE)
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<OAuthTokens> {
  // The code from the callback page may include a state suffix (code#state)
  const parts = code.split("#");
  const actualCode = parts[0];
  const stateFromCode = parts[1];

  const requestBody: Record<string, string> = {
    code: actualCode!,
    grant_type: "authorization_code",
    client_id: config.anthropicClientId,
    redirect_uri: config.anthropicRedirectUri,
    code_verifier: codeVerifier,
  };

  if (stateFromCode) {
    requestBody["state"] = stateFromCode;
  }

  logger.info(
    { codeLength: actualCode?.length, verifierLength: codeVerifier.length },
    "Exchanging code for tokens"
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error(
      { status: response.status, body },
      "Token exchange failed"
    );
    throw new Error(`Token exchange failed: ${response.status} - ${body}`);
  }

  const tokenResponse = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_in: tokenResponse.expires_in,
  };
}

/**
 * Refresh an expired token
 */
export async function refreshUserToken(userId: string): Promise<boolean> {
  const db = getDatabase();

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as {
    refresh_token: string | null;
  } | undefined;

  if (!user || !user.refresh_token) {
    return false;
  }

  try {
    const refreshToken = decrypt(user.refresh_token);
    const tokens = await refreshToken_(refreshToken);

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Encrypt and store new tokens
    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = encrypt(tokens.refresh_token);

    db.prepare(
      `UPDATE users SET 
        access_token = ?, 
        refresh_token = ?, 
        token_expires_at = ?,
        is_rate_limited = 0
      WHERE id = ?`
    ).run(encryptedAccessToken, encryptedRefreshToken, expiresAt, userId);

    logger.info({ userId }, "Token refreshed successfully");
    return true;
  } catch (error) {
    logger.error({ userId, error }, "Failed to refresh token");
    return false;
  }
}

/**
 * Refresh token API call
 */
async function refreshToken_(refreshToken: string): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.anthropicClientId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${body}`);
  }

  const tokenResponse = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_in: tokenResponse.expires_in,
  };
}

/**
 * Get decrypted access token for a user (refreshing if needed)
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const db = getDatabase();

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as {
    access_token: string | null;
    token_expires_at: string | null;
  } | undefined;

  if (!user || !user.access_token) {
    return null;
  }

  // Check if token is expired (with 5 minute buffer)
  if (user.token_expires_at) {
    const expiresAt = new Date(user.token_expires_at);
    const bufferTime = 5 * 60 * 1000; // 5 minutes
    if (expiresAt.getTime() - bufferTime < Date.now()) {
      // Token is expired or about to expire, refresh it
      const refreshed = await refreshUserToken(userId);
      if (!refreshed) {
        return null;
      }
      // Get the new token
      const updatedUser = db.prepare("SELECT access_token FROM users WHERE id = ?").get(userId) as {
        access_token: string | null;
      } | undefined;
      if (!updatedUser?.access_token) {
        return null;
      }
      return decrypt(updatedUser.access_token);
    }
  }

  return decrypt(user.access_token);
}

/**
 * Remove account (unlink Anthropic) for a user
 */
export function removeAccount(userId: string): void {
  const db = getDatabase();

  db.prepare(
    `UPDATE users SET 
      access_token = NULL, 
      refresh_token = NULL, 
      token_expires_at = NULL,
      is_active = 0,
      usage_5h = 0,
      usage_7d = 0,
      reset_5h = NULL,
      reset_7d = NULL,
      usage_updated_at = NULL,
      is_rate_limited = 0,
      rate_limited_until = NULL
    WHERE id = ?`
  ).run(userId);

  logger.info({ userId }, "Account unlinked");
}

/**
 * Clean up expired OAuth sessions (older than 10 minutes)
 */
export function cleanupExpiredSessions(): void {
  const db = getDatabase();
  const result = db
    .prepare(
      "DELETE FROM oauth_sessions WHERE created_at < datetime('now', '-10 minutes')"
    )
    .run();

  if (result.changes > 0) {
    logger.info({ count: result.changes }, "Cleaned up expired OAuth sessions");
  }
}
