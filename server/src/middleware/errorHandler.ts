import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("error-handler");

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function createError(
  message: string,
  statusCode: number,
  code?: string
): AppError {
  const error: AppError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export const errorHandler: ErrorRequestHandler = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  if (statusCode >= 500) {
    logger.error({ err, statusCode }, "Server error");
  } else {
    logger.warn({ statusCode, message, code: err.code }, "Client error");
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    code: err.code,
  });
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Not found: ${req.method} ${req.path}`,
    code: "NOT_FOUND",
  });
}
