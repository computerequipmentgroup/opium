import type { Request, Response, NextFunction } from "express";
import { authenticateByApiKey } from "../services/auth.js";
import { createError } from "./errorHandler.js";
import type { User } from "../types/index.js";

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Authentication middleware
 * Requires valid API key in Authorization header
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw createError("Missing Authorization header", 401, "UNAUTHORIZED");
    }

    // Support "Bearer <token>" format
    const parts = authHeader.split(" ");
    let apiKey: string;

    if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
      apiKey = parts[1] || "";
    } else {
      // Also support just the token directly
      apiKey = authHeader;
    }

    if (!apiKey || !apiKey.startsWith("op_")) {
      throw createError(
        "Invalid API key format",
        401,
        "INVALID_API_KEY_FORMAT"
      );
    }

    const user = await authenticateByApiKey(apiKey);

    if (!user) {
      throw createError("Invalid API key", 401, "INVALID_API_KEY");
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Optional authentication middleware
 * Sets req.user if valid API key is provided, but doesn't fail if not
 */
export async function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return next();
    }

    const parts = authHeader.split(" ");
    let apiKey: string;

    if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
      apiKey = parts[1] || "";
    } else {
      apiKey = authHeader;
    }

    if (apiKey && apiKey.startsWith("op_")) {
      const user = await authenticateByApiKey(apiKey);
      if (user) {
        req.user = user;
      }
    }

    next();
  } catch {
    // Ignore auth errors in optional mode
    next();
  }
}
