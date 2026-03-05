import { Router, type Request, type Response, type NextFunction } from "express";
import { registerUser, regenerateApiKey, toUserInfo } from "../services/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";
import { config } from "../config.js";

const router = Router();

/**
 * POST /api/v1/users/register
 * Register a new user (requires master API key)
 */
router.post(
  "/register",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate master API key
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        throw createError("Missing Authorization header", 401, "UNAUTHORIZED");
      }

      // Support "Bearer <token>" format
      const parts = authHeader.split(" ");
      let providedKey: string;
      if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
        providedKey = parts[1] || "";
      } else {
        providedKey = authHeader;
      }

      if (providedKey !== config.masterApiKey) {
        throw createError("Invalid master API key", 401, "UNAUTHORIZED");
      }

      // Validate username
      const { username } = req.body as { username?: string };

      if (!username || typeof username !== "string") {
        throw createError("Username is required", 400, "MISSING_USERNAME");
      }

      const trimmedUsername = username.trim();
      if (trimmedUsername.length === 0) {
        throw createError("Username cannot be empty", 400, "INVALID_USERNAME");
      }

      const result = await registerUser(trimmedUsername);

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Username already taken") {
        return next(createError(error.message, 409, "USERNAME_EXISTS"));
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
