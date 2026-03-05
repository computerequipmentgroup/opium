import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getPoolMembersForUser, getPoolStatus, syncAllAccountsUsage } from "../services/pool.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("pool-route");
const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/v1/pool
 * Get all pool members
 */
router.get(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      logger.info({ userId: user.id, email: user.email, hasToken: user.access_token !== null }, "GET /pool request");
      const members = getPoolMembersForUser(user.id);
      const status = getPoolStatus();
      logger.info({ memberCount: members.length, status }, "GET /pool response");

      res.json({
        success: true,
        data: {
          members,
          summary: {
            total_members: status.total_members,
            active_accounts: status.active_accounts,
            rate_limited: status.rate_limited_accounts,
            available: status.available_accounts,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/pool/status
 * Get pool status summary
 */
router.get(
  "/status",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = getPoolStatus();

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/pool/sync
 * Sync usage for all pool members by making minimal API requests
 */
router.post(
  "/sync",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info("Starting pool-wide usage sync");
      const result = await syncAllAccountsUsage();

      // Get updated pool status
      const status = getPoolStatus();

      res.json({
        success: true,
        data: {
          sync_result: result,
          status,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
