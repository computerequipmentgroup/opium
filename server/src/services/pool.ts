import { getDatabase } from "../db/index.js";
import { createChildLogger } from "../utils/logger.js";
import { decrypt } from "../utils/crypto.js";
import { getValidAccessToken } from "./oauth.js";
import type { User, PoolMember, PoolStatus } from "../types/index.js";

const logger = createChildLogger("pool");

/**
 * Get all users with linked accounts (pool members)
 */
export function getAllPoolMembers(): User[] {
  const db = getDatabase();
  const members = db
    .prepare("SELECT * FROM users WHERE access_token IS NOT NULL")
    .all() as User[];
  logger.debug({ count: members.length, ids: members.map(m => m.id) }, "getAllPoolMembers query result");
  return members;
}

/**
 * Get pool members formatted for API response
 */
export function getPoolMembersForUser(requestingUserId: string): PoolMember[] {
  logger.debug({ requestingUserId }, "getPoolMembersForUser called");
  const members = getAllPoolMembers();
  logger.debug({ memberCount: members.length, requestingUserId }, "Mapping pool members");

  // Find the best account that would be selected for the requesting user
  const available = members.filter(
    (m) =>
      m.is_active &&
      !m.is_rate_limited &&
      canAccountBeUsedBy(m, requestingUserId)
  );
  
  logger.debug(
    { 
      availableCount: available.length,
      availableAccounts: available.map(a => ({ 
        id: a.id, 
        username: a.username,
        loadScore: calculateLoadScore(a),
        usage5h: a.usage_5h
      }))
    },
    "Available accounts before sort"
  );
  
  available.sort((a, b) => calculateLoadScore(a) - calculateLoadScore(b));
  
  logger.debug(
    { 
      sortedAccounts: available.map(a => ({ 
        id: a.id, 
        username: a.username,
        loadScore: calculateLoadScore(a)
      }))
    },
    "Available accounts after sort"
  );
  
  const nextAccount = available[0];
  const nextAccountId = nextAccount?.id ?? null;
  
  logger.debug(
    { nextAccountId, nextAccountUsername: nextAccount?.username },
    "Selected next account"
  );

  return members.map((member) => ({
    id: member.id,
    username: member.username,
    is_active: Boolean(member.is_active),
    share_limit_percent: member.share_limit_percent,
    usage: member.is_active
      ? {
          usage_5h: member.usage_5h,
          usage_7d: member.usage_7d,
          reset_5h: member.reset_5h,
          reset_7d: member.reset_7d,
          updated_at: member.usage_updated_at,
        }
      : null,
    is_rate_limited: Boolean(member.is_rate_limited),
    is_me: member.id === requestingUserId,
    is_next: member.id === nextAccountId,
    load_score: member.is_active ? calculateLoadScore(member) : null,
  }));
}

/**
 * Get pool status summary
 */
export function getPoolStatus(): PoolStatus {
  const db = getDatabase();

  const members = getAllPoolMembers();
  const activeMembers = members.filter((m) => m.is_active);
  const rateLimitedMembers = activeMembers.filter((m) => m.is_rate_limited);
  const availableMembers = activeMembers.filter((m) => !m.is_rate_limited);

  // Calculate weighted average usage
  let totalUsage5h = 0;
  let totalUsage7d = 0;
  for (const member of activeMembers) {
    totalUsage5h += member.usage_5h;
    totalUsage7d += member.usage_7d;
  }

  return {
    total_members: members.length,
    active_accounts: activeMembers.length,
    rate_limited_accounts: rateLimitedMembers.length,
    available_accounts: availableMembers.length,
    pool_usage_5h: activeMembers.length > 0 ? totalUsage5h / activeMembers.length : 0,
    pool_usage_7d: activeMembers.length > 0 ? totalUsage7d / activeMembers.length : 0,
  };
}

/**
 * Check if an account can be used by a specific user
 * Owner can always use their own account
 * Others can use if share limit allows OR if account is about to reset (drain mode)
 */
export function canAccountBeUsedBy(account: User, requesterId: string): boolean {
  // Owner can always use their own account
  if (account.id === requesterId) {
    return true;
  }

  // If share limit is 0, only owner can use
  if (account.share_limit_percent === 0) {
    return false;
  }

  // If account resets in <= 10 min and not fully used, ignore share limit - drain it!
  const minutesUntilReset = getMinutesUntilReset(account);
  const shouldDrain = minutesUntilReset <= 10 && account.usage_5h < 0.95;
  
  if (shouldDrain) {
    logger.debug(
      { accountId: account.id, requesterId, minutesUntilReset, usage5h: account.usage_5h },
      "Ignoring share limit - drain mode active"
    );
    return true;
  }

  // Check if current usage is below the share limit
  // e.g., share_limit_percent=80 means others can use until usage_5h reaches 80%
  const usagePercent = account.usage_5h * 100;
  return usagePercent < account.share_limit_percent;
}

/**
 * Calculate minutes until 5h reset
 * Returns Infinity if no reset time available
 */
function getMinutesUntilReset(account: User): number {
  if (!account.reset_5h) return Infinity;
  
  const resetTime = parseInt(account.reset_5h, 10) * 1000;
  const now = Date.now();
  const diff = resetTime - now;
  
  if (diff <= 0) return 0;
  return Math.floor(diff / 60000);
}

/**
 * Check if any account is about to reset and should be drained
 * Returns the account that should be drained, or null if none
 * 
 * Drain threshold: < 30 minutes until reset AND not fully used (< 95%)
 */
function getAccountToDrain(accounts: User[]): User | null {
  const DRAIN_THRESHOLD_MINUTES = 30;
  const FULLY_USED_THRESHOLD = 0.95;
  
  for (const account of accounts) {
    const minutesUntilReset = getMinutesUntilReset(account);
    
    if (minutesUntilReset <= DRAIN_THRESHOLD_MINUTES && account.usage_5h < FULLY_USED_THRESHOLD) {
      logger.info(
        { 
          accountId: account.id, 
          usage5h: account.usage_5h,
          minutesUntilReset 
        },
        "Account should be drained before reset"
      );
      return account;
    }
  }
  
  return null;
}

/**
 * Calculate load score for an account (lower is better)
 * 
 * Base score: usage_5h * 2 + usage_7d
 * 
 * Reset bonus: If account resets soon, reduce score to prioritize it.
 * - Resets in < 30 min: score = -1000 (FORCE drain this account)
 * - Resets in < 60 min: multiply score by 0.2
 * - Resets in < 120 min: multiply score by 0.5
 * 
 * This ensures accounts about to reset get fully drained.
 */
export function calculateLoadScore(account: User): number {
  const baseScore = account.usage_5h * 2 + account.usage_7d;
  const minutesUntilReset = getMinutesUntilReset(account);
  
  // If resetting very soon and not fully used, force this account to be selected
  if (minutesUntilReset <= 30 && account.usage_5h < 0.95) {
    logger.debug(
      { 
        accountId: account.id, 
        usage5h: account.usage_5h,
        minutesUntilReset,
        finalScore: -1000
      },
      "Forcing account selection - draining before reset"
    );
    return -1000; // Negative score guarantees selection
  }
  
  // Apply reset bonus - the sooner the reset, the lower the score
  let resetMultiplier = 1.0;
  if (minutesUntilReset <= 60) {
    resetMultiplier = 0.2;  // Strongly prefer
  } else if (minutesUntilReset <= 120) {
    resetMultiplier = 0.5;  // Moderately prefer
  }
  
  const finalScore = baseScore * resetMultiplier;
  
  logger.debug(
    { 
      accountId: account.id, 
      usage5h: account.usage_5h,
      usage7d: account.usage_7d,
      minutesUntilReset, 
      baseScore, 
      resetMultiplier, 
      finalScore 
    },
    "Calculated load score"
  );
  
  return finalScore;
}

/**
 * Select the best available account for a request
 * Returns null if no accounts are available
 */
export async function selectBestAccount(
  requesterId: string
): Promise<{ user: User; accessToken: string } | null> {
  const members = getAllPoolMembers();

  // Filter to available accounts
  const available = members.filter(
    (m) =>
      m.is_active &&
      !m.is_rate_limited &&
      canAccountBeUsedBy(m, requesterId)
  );

  if (available.length === 0) {
    logger.warn({ requesterId }, "No accounts available in pool");
    return null;
  }

  // Sort by load score (lowest first)
  available.sort((a, b) => calculateLoadScore(a) - calculateLoadScore(b));

  // Try to get a valid access token for the best account
  for (const account of available) {
    const accessToken = await getValidAccessToken(account.id);
    if (accessToken) {
      logger.debug(
        { accountId: account.id, requesterId, loadScore: calculateLoadScore(account) },
        "Selected account for request"
      );
      return { user: account, accessToken };
    }
  }

  logger.warn({ requesterId }, "No accounts with valid tokens available");
  return null;
}

/**
 * Mark an account as rate limited
 */
export function markAccountRateLimited(
  accountId: string,
  retryAfterSeconds?: number
): void {
  const db = getDatabase();

  let rateLimitedUntil: string | null = null;
  if (retryAfterSeconds) {
    rateLimitedUntil = new Date(
      Date.now() + retryAfterSeconds * 1000
    ).toISOString();
  }

  db.prepare(
    `UPDATE users SET 
      is_rate_limited = 1, 
      rate_limited_until = ?
    WHERE id = ?`
  ).run(rateLimitedUntil, accountId);

  logger.info(
    { accountId, retryAfterSeconds, rateLimitedUntil },
    "Account marked as rate limited"
  );
}

/**
 * Clear rate limit for an account
 */
export function clearAccountRateLimit(accountId: string): void {
  const db = getDatabase();

  db.prepare(
    `UPDATE users SET 
      is_rate_limited = 0, 
      rate_limited_until = NULL
    WHERE id = ?`
  ).run(accountId);

  logger.info({ accountId }, "Account rate limit cleared");
}

/**
 * Check and clear expired rate limits
 */
export function clearExpiredRateLimits(): void {
  const db = getDatabase();

  // Clear rate limits with explicit expiration
  const result = db
    .prepare(
      `UPDATE users SET 
        is_rate_limited = 0, 
        rate_limited_until = NULL
      WHERE is_rate_limited = 1 
        AND rate_limited_until IS NOT NULL 
        AND rate_limited_until < datetime('now')`
    )
    .run();

  if (result.changes > 0) {
    logger.info({ count: result.changes }, "Cleared expired rate limits");
  }

  // Also clear rate limits without expiration (shouldn't happen, but safety net)
  // These get cleared after 5 minutes of being set
  const orphanResult = db
    .prepare(
      `UPDATE users SET 
        is_rate_limited = 0, 
        rate_limited_until = NULL
      WHERE is_rate_limited = 1 
        AND rate_limited_until IS NULL`
    )
    .run();

  if (orphanResult.changes > 0) {
    logger.warn({ count: orphanResult.changes }, "Cleared orphaned rate limits (missing expiration)");
  }
}

/**
 * Update account usage stats from Anthropic rate limit headers
 */
export function updateAccountUsage(
  accountId: string,
  usage5h: number,
  usage7d: number,
  reset5h?: string,
  reset7d?: string
): void {
  const db = getDatabase();

  // Account is exhausted if either 5h or 7d usage is at 99% or higher
  const isExhausted = usage5h >= 0.99 || usage7d >= 0.99;

  logger.info(
    { accountId, usage5h, usage7d, reset5h, reset7d, isExhausted },
    "Updating account usage"
  );

  if (isExhausted) {
    // Mark as rate limited when exhausted
    // Calculate seconds until reset based on which limit is exhausted
    let rateLimitedUntil: string | null = null;
    if (usage5h >= 0.99 && reset5h) {
      rateLimitedUntil = new Date(parseInt(reset5h) * 1000).toISOString();
    } else if (usage7d >= 0.99 && reset7d) {
      rateLimitedUntil = new Date(parseInt(reset7d) * 1000).toISOString();
    }

    db.prepare(
      `UPDATE users SET 
        usage_5h = ?,
        usage_7d = ?,
        reset_5h = COALESCE(?, reset_5h),
        reset_7d = COALESCE(?, reset_7d),
        usage_updated_at = datetime('now'),
        is_rate_limited = 1,
        rate_limited_until = ?
      WHERE id = ?`
    ).run(usage5h, usage7d, reset5h, reset7d, rateLimitedUntil, accountId);
    
    logger.info({ accountId, rateLimitedUntil }, "Account marked as exhausted (usage >= 99%)");
  } else {
    // Clear rate limit if usage is back to normal
    db.prepare(
      `UPDATE users SET 
        usage_5h = ?,
        usage_7d = ?,
        reset_5h = COALESCE(?, reset_5h),
        reset_7d = COALESCE(?, reset_7d),
        usage_updated_at = datetime('now'),
        is_rate_limited = 0,
        rate_limited_until = NULL
      WHERE id = ?`
    ).run(usage5h, usage7d, reset5h, reset7d, accountId);
  }
}



const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20,interleaved-thinking-2025-05-14";
// Use the cheapest/fastest model for sync - we only need the rate limit headers
const SYNC_MODEL = "claude-3-haiku-20240307";

/**
 * Sync usage for a single account by making a minimal API request
 */
export async function syncAccountUsage(accountId: string): Promise<boolean> {
  const accessToken = await getValidAccessToken(accountId);
  if (!accessToken) {
    logger.warn({ accountId }, "Cannot sync account - no valid access token");
    return false;
  }

  try {
    // Make a minimal API call to get rate limit headers
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SYNC_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });

    // Log all rate limit headers for debugging
    const allHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.includes("ratelimit") || key.includes("retry")) {
        allHeaders[key] = value;
      }
    });
    logger.info({ accountId, status: response.status, headers: allHeaders }, "Response headers from Anthropic");

    // Check for error response
    if (!response.ok) {
      const body = await response.text();
      logger.error({ accountId, status: response.status, body }, "Sync API call failed");
      
      // If rate limited (429), mark the account as drained so it's excluded from selection
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : 300; // Default 5 min
        markAccountRateLimited(accountId, retryAfterSeconds);
        
        // Update usage from headers, fallback to 100% if not provided
        const usage5hHeader = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
        const usage7dHeader = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
        const reset5hHeader = response.headers.get("anthropic-ratelimit-unified-5h-reset");
        const reset7dHeader = response.headers.get("anthropic-ratelimit-unified-7d-reset");
        
        const usage5h = usage5hHeader ? parseFloat(usage5hHeader) : 1.0;
        const usage7d = usage7dHeader ? parseFloat(usage7dHeader) : 1.0;
        
        updateAccountUsage(
          accountId,
          isNaN(usage5h) ? 1.0 : usage5h,
          isNaN(usage7d) ? 1.0 : usage7d,
          reset5hHeader ?? undefined,
          reset7dHeader ?? undefined
        );
        
        logger.info(
          { accountId, retryAfterSeconds },
          "Account marked as drained (rate limited during sync)"
        );
      }
      
      return false;
    }

    // Parse rate limit headers
    const headers = response.headers;
    const usage5hHeader = headers.get("anthropic-ratelimit-unified-5h-utilization");
    const usage7dHeader = headers.get("anthropic-ratelimit-unified-7d-utilization");
    const reset5hHeader = headers.get("anthropic-ratelimit-unified-5h-reset");
    const reset7dHeader = headers.get("anthropic-ratelimit-unified-7d-reset");

    logger.info(
      { 
        accountId, 
        status: response.status,
        usage5h: usage5hHeader, 
        usage7d: usage7dHeader,
        reset5h: reset5hHeader,
        reset7d: reset7dHeader,
      },
      "Synced account usage from Anthropic"
    );

    const usage5h = usage5hHeader ? parseFloat(usage5hHeader) : undefined;
    const usage7d = usage7dHeader ? parseFloat(usage7dHeader) : undefined;

    if (usage5h !== undefined && !isNaN(usage5h)) {
      updateAccountUsage(
        accountId,
        usage5h,
        usage7d !== undefined && !isNaN(usage7d) ? usage7d : 0,
        reset5hHeader ?? undefined,
        reset7dHeader ?? undefined
      );
      return true;
    }

    logger.warn({ accountId }, "No usage headers received from Anthropic");
    return false;
  } catch (error) {
    logger.error({ accountId, error }, "Failed to sync account usage");
    return false;
  }
}

/**
 * Sync usage for all pool members
 */
export async function syncAllAccountsUsage(): Promise<{ synced: number; failed: number }> {
  const members = getAllPoolMembers();
  let synced = 0;
  let failed = 0;

  for (const member of members) {
    const success = await syncAccountUsage(member.id);
    if (success) {
      synced++;
    } else {
      failed++;
    }
  }

  logger.info({ synced, failed, total: members.length }, "Completed syncing all accounts");
  return { synced, failed };
}
