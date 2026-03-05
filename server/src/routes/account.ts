import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";
import { startOAuthFlow, completeOAuthFlow, removeAccount } from "../services/oauth.js";
import { toUserInfo } from "../services/auth.js";
import { getDatabase } from "../db/index.js";
import { syncAccountUsage } from "../services/pool.js";

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * POST /api/v1/account/oauth/start
 * Start OAuth flow to link Anthropic account
 */
router.post(
  "/oauth/start",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;

      // Check if user already has an account linked
      if (user.access_token) {
        throw createError(
          "Account already linked. Remove it first to link a new one.",
          400,
          "ACCOUNT_ALREADY_LINKED"
        );
      }

      const { authUrl, state } = startOAuthFlow(user.id);

      res.json({
        success: true,
        data: {
          auth_url: authUrl,
          state,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/account/oauth/complete
 * Complete OAuth flow with authorization code
 */
router.post(
  "/oauth/complete",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const { code, state } = req.body as { code?: string; state?: string };

      if (!code || typeof code !== "string") {
        throw createError("Authorization code is required", 400, "MISSING_CODE");
      }

      if (!state || typeof state !== "string") {
        throw createError("State is required", 400, "MISSING_STATE");
      }

      await completeOAuthFlow(user.id, code, state);

      // Get updated user info
      const db = getDatabase();
      const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);

      res.json({
        success: true,
        data: {
          account: toUserInfo(updatedUser as typeof user).account,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid or expired")) {
        return next(createError(error.message, 400, "INVALID_OAUTH_SESSION"));
      }
      if (error instanceof Error && error.message.includes("Token exchange failed")) {
        return next(createError(error.message, 400, "TOKEN_EXCHANGE_FAILED"));
      }
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/account
 * Update account settings (is_active, share_limit_percent)
 */
router.patch(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const { is_active, share_limit_percent } = req.body as {
        is_active?: boolean;
        share_limit_percent?: number;
      };

      // Must have account linked to update settings
      if (!user.access_token) {
        throw createError(
          "No account linked. Link an Anthropic account first.",
          400,
          "NO_ACCOUNT_LINKED"
        );
      }

      const db = getDatabase();
      const updates: string[] = [];
      const values: (number | string)[] = [];

      if (typeof is_active === "boolean") {
        updates.push("is_active = ?");
        values.push(is_active ? 1 : 0);
      }

      if (typeof share_limit_percent === "number") {
        if (share_limit_percent < 0 || share_limit_percent > 100) {
          throw createError(
            "share_limit_percent must be between 0 and 100",
            400,
            "INVALID_SHARE_LIMIT"
          );
        }
        updates.push("share_limit_percent = ?");
        values.push(Math.round(share_limit_percent));
      }

      if (updates.length === 0) {
        throw createError(
          "No valid fields to update",
          400,
          "NO_FIELDS_TO_UPDATE"
        );
      }

      values.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(
        ...values
      );

      // Get updated user info
      const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);

      res.json({
        success: true,
        data: toUserInfo(updatedUser as typeof user).account,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/account
 * Remove (unlink) Anthropic account
 */
router.delete(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;

      if (!user.access_token) {
        throw createError(
          "No account linked",
          400,
          "NO_ACCOUNT_LINKED"
        );
      }

      removeAccount(user.id);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/account/sync
 * Sync account usage from Anthropic by making a minimal API request
 */
router.post(
  "/sync",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;

      if (!user.access_token) {
        throw createError(
          "No account linked",
          400,
          "NO_ACCOUNT_LINKED"
        );
      }

      // Sync usage from Anthropic
      const success = await syncAccountUsage(user.id);

      if (!success) {
        throw createError(
          "Failed to sync account usage",
          500,
          "SYNC_FAILED"
        );
      }

      // Get updated user info
      const db = getDatabase();
      const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as typeof user;

      res.json({
        success: true,
        data: {
          usage: {
            usage_5h: updatedUser.usage_5h,
            usage_7d: updatedUser.usage_7d,
            reset_5h: updatedUser.reset_5h,
            reset_7d: updatedUser.reset_7d,
            updated_at: updatedUser.usage_updated_at,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
