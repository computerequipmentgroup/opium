import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getDatabase } from "../db/index.js";
import { getValidAccessToken } from "./oauth.js";
import { decrypt } from "../utils/crypto.js";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("claude-home");

// Tracks the access token most recently written for each account so we can
// skip redundant disk writes on the hot path. A mismatch means a refresh
// happened and the file needs to be rewritten.
const writtenTokens = new Map<string, string>();

// Per-account async lock. Parallel requests for the same account queue up
// so they can't clobber the credentials file mid-write.
const locks = new Map<string, Promise<void>>();

async function withAccountLock<T>(
  accountId: string,
  fn: () => Promise<T>
): Promise<T> {
  while (locks.has(accountId)) {
    await locks.get(accountId);
  }
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(accountId, lock);
  try {
    return await fn();
  } finally {
    locks.delete(accountId);
    release();
  }
}

/**
 * Materialize a HOME directory for the given account containing
 * `$HOME/.claude/.credentials.json` in the shape the Claude CLI reads.
 *
 * The returned path can be passed as `env.HOME` when spawning `claude`.
 * Returns null if the account has no usable credentials.
 */
export async function materializeAccountHome(
  accountId: string
): Promise<string | null> {
  return withAccountLock(accountId, async () => {
    const accessToken = await getValidAccessToken(accountId);
    if (!accessToken) {
      logger.warn({ accountId }, "No valid access token for account");
      return null;
    }

    const home = join(config.claudeHomeRoot, accountId);

    if (writtenTokens.get(accountId) === accessToken) {
      return home;
    }

    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT refresh_token, token_expires_at FROM users WHERE id = ?"
      )
      .get(accountId) as
      | { refresh_token: string | null; token_expires_at: string | null }
      | undefined;

    const refreshToken = row?.refresh_token ? decrypt(row.refresh_token) : "";
    const expiresAt = row?.token_expires_at
      ? new Date(row.token_expires_at).getTime()
      : Date.now() + 3600_000;

    const credentials = {
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt,
        scopes: ["org:create_api_key", "user:profile", "user:inference"],
      },
    };

    const claudeDir = join(home, ".claude");
    await mkdir(claudeDir, { recursive: true, mode: 0o700 });

    const credPath = join(claudeDir, ".credentials.json");
    const tmpPath = `${credPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(credentials), { mode: 0o600 });
    await rename(tmpPath, credPath);

    writtenTokens.set(accountId, accessToken);
    logger.debug({ accountId, home }, "Materialized account HOME");

    return home;
  });
}

/**
 * Force the next `materializeAccountHome` call to rewrite the credentials
 * file, even if the cached access token still matches. Use this when an
 * external signal indicates the stored creds are stale.
 */
export function invalidateAccountHome(accountId: string): void {
  writtenTokens.delete(accountId);
}
