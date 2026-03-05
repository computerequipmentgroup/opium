import { Router, type Request, type Response, type NextFunction } from "express";
import { registerUser, regenerateApiKey, toUserInfo } from "../services/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";

const router = Router();

/**
 * POST /api/v1/users/register
 * Register a new user (no auth required)
 */
router.post(
  "/register",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body as { email?: string };

      if (!email || typeof email !== "string") {
        throw createError("Email is required", 400, "MISSING_EMAIL");
      }

      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        throw createError("Invalid email format", 400, "INVALID_EMAIL");
      }

      const result = await registerUser(email.toLowerCase().trim());

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Email already registered") {
        return next(createError(error.message, 409, "EMAIL_EXISTS"));
      }
      next(error);
    }
  }
);

/**
 * GET /api/v1/users/me
 * Get current user info
 */
router.get(
  "/me",
  authMiddleware,
  (req: Request, res: Response) => {
    const user = req.user!;
    const userInfo = toUserInfo(user);

    res.json({
      success: true,
      data: userInfo,
    });
  }
);

/**
 * POST /api/v1/users/me/regenerate-key
 * Regenerate API key for current user
 */
router.post(
  "/me/regenerate-key",
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const newApiKey = await regenerateApiKey(user.id);

      res.json({
        success: true,
        data: {
          api_key: newApiKey,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
