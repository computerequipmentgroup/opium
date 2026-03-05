import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { proxyRequest } from "../services/proxy.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("proxy-route");
const router = Router();

// All proxy routes require authentication
router.use(authMiddleware);

/**
 * Proxy all requests to Anthropic API
 * POST /v1/messages, /v1/complete, etc.
 */
router.all(
  "*",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;

      logger.info(
        { userId: user.id, method: req.method, path: req.path },
        "Proxying request"
      );

      await proxyRequest(req, res, user.id);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
