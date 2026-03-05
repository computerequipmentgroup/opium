import type { Request, Response } from "express";
import { createChildLogger } from "../utils/logger.js";
import {
  selectBestAccount,
  markAccountRateLimited,
  updateAccountUsage,
  clearExpiredRateLimits,
} from "./pool.js";
import type { User } from "../types/index.js";

const logger = createChildLogger("proxy");

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20,interleaved-thinking-2025-05-14";

interface ProxyResult {
  success: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body?: ReadableStream<Uint8Array> | string;
  accountUsed?: string;
}

/**
 * Parse rate limit headers from Anthropic response
 */
function parseRateLimitHeaders(headers: Headers): {
  usage5h?: number;
  usage7d?: number;
  reset5h?: string;
  reset7d?: string;
  status?: string;
  retryAfter?: number;
} {
  const result: ReturnType<typeof parseRateLimitHeaders> = {};

  // Parse the direct utilization headers (0.0 to 1.0)
  const usage5hHeader = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const usage7dHeader = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const reset5hHeader = headers.get("anthropic-ratelimit-unified-5h-reset");
  const reset7dHeader = headers.get("anthropic-ratelimit-unified-7d-reset");
  const statusHeader = headers.get("anthropic-ratelimit-unified-status");
  const retryAfter = headers.get("retry-after");

  if (usage5hHeader) {
    const parsed = parseFloat(usage5hHeader);
    if (!isNaN(parsed)) {
      result.usage5h = parsed;
    }
  }

  if (usage7dHeader) {
    const parsed = parseFloat(usage7dHeader);
    if (!isNaN(parsed)) {
      result.usage7d = parsed;
    }
  }

  if (reset5hHeader) {
    result.reset5h = reset5hHeader;
  }

  if (reset7dHeader) {
    result.reset7d = reset7dHeader;
  }

  if (statusHeader) {
    result.status = statusHeader;
  }

  if (retryAfter) {
    result.retryAfter = parseInt(retryAfter, 10);
  }

  return result;
}

/**
 * Forward request to Anthropic API
 */
async function forwardRequest(
  req: Request,
  accessToken: string,
  accountId: string
): Promise<{ response: globalThis.Response; rateLimits: ReturnType<typeof parseRateLimitHeaders> }> {
  // Build the target URL
  const targetPath = req.originalUrl.replace(/^\/v1/, "/v1");
  const targetUrl = `${ANTHROPIC_API_BASE}${targetPath}${targetPath.includes("?") ? "&" : "?"}beta=true`;

  // Build headers
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "anthropic-beta": ANTHROPIC_BETA_HEADER,
    "Content-Type": "application/json",
  };

  // Copy relevant headers from original request
  if (req.headers["anthropic-version"]) {
    headers["anthropic-version"] = req.headers["anthropic-version"] as string;
  }

  logger.debug(
    { targetUrl, accountId, method: req.method },
    "Forwarding request to Anthropic"
  );

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
  });

  const rateLimits = parseRateLimitHeaders(response.headers);

  return { response, rateLimits };
}

/**
 * Proxy a request to Anthropic API using the best available account
 */
export async function proxyRequest(
  req: Request,
  res: Response,
  requesterId: string
): Promise<void> {
  // Clear any expired rate limits first
  clearExpiredRateLimits();

  // Track retry attempts
  const maxRetries = 3;
  let attempts = 0;
  const triedAccounts = new Set<string>();

  while (attempts < maxRetries) {
    attempts++;

    // Select best account, excluding already tried ones
    const selection = await selectBestAccount(requesterId);

    if (!selection) {
      logger.warn({ requesterId, attempts }, "No accounts available for proxy request");
      res.status(503).json({
        success: false,
        error: "No accounts available. All accounts may be rate limited.",
        code: "NO_ACCOUNTS_AVAILABLE",
      });
      return;
    }

    const { user: account, accessToken } = selection;

    // Skip if we already tried this account
    if (triedAccounts.has(account.id)) {
      continue;
    }
    triedAccounts.add(account.id);

    try {
      const { response, rateLimits } = await forwardRequest(
        req,
        accessToken,
        account.id
      );

      // Update usage stats if we got rate limit info
      logger.debug(
        { accountId: account.id, rateLimits, responseStatus: response.status },
        "Received rate limit headers from Anthropic"
      );

      if (rateLimits.usage5h !== undefined) {
        updateAccountUsage(
          account.id,
          rateLimits.usage5h,
          rateLimits.usage7d ?? account.usage_7d,
          rateLimits.reset5h,
          rateLimits.reset7d
        );
      }

      // Check for rate limit status
      if (rateLimits.status === "limited" || rateLimits.status === "rejected") {
        logger.info(
          { accountId: account.id, status: rateLimits.status },
          "Account preemptively rate limited"
        );
        markAccountRateLimited(account.id, rateLimits.retryAfter || 300);
      }

      // Handle rate limit response
      if (response.status === 429) {
        logger.warn(
          { accountId: account.id, retryAfter: rateLimits.retryAfter },
          "Account rate limited (429)"
        );
        markAccountRateLimited(account.id, rateLimits.retryAfter || 300);

        // Try with another account
        continue;
      }



      // Check if this is a streaming response
      const contentType = response.headers.get("content-type") || "";
      const isStreaming = contentType.includes("text/event-stream");

      // Set response headers
      res.status(response.status);
      
      // Copy relevant headers
      const headersToCopy = [
        "content-type",
        "x-request-id",
        "anthropic-ratelimit-requests-limit",
        "anthropic-ratelimit-requests-remaining",
        "anthropic-ratelimit-requests-reset",
        "anthropic-ratelimit-tokens-limit",
        "anthropic-ratelimit-tokens-remaining",
        "anthropic-ratelimit-tokens-reset",
      ];

      for (const header of headersToCopy) {
        const value = response.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      }

      // Add custom header to indicate which account was used
      res.setHeader("x-opium-account-id", account.id);

      if (isStreaming && response.body) {
        // Stream the response
        const reader = response.body.getReader();
        
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (streamError) {
          logger.error({ error: streamError }, "Error streaming response");
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: "Error streaming response",
              code: "STREAM_ERROR",
            });
          } else {
            res.end();
          }
        }
      } else {
        // Non-streaming response
        const body = await response.text();
        res.send(body);
      }

      return;
    } catch (error) {
      logger.error(
        { accountId: account.id, error, attempts },
        "Error proxying request"
      );

      // If this is a network error, try another account
      if (attempts < maxRetries) {
        continue;
      }

      res.status(502).json({
        success: false,
        error: "Failed to proxy request to Anthropic",
        code: "PROXY_ERROR",
      });
      return;
    }
  }

  // All retries exhausted
  res.status(503).json({
    success: false,
    error: "All available accounts are rate limited or unavailable",
    code: "ALL_ACCOUNTS_EXHAUSTED",
  });
}
