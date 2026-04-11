import type { Request, Response } from 'express';
import type pino from 'pino';

import { wrapUnknown } from './errors.js';
import { buildErrorMetadata } from './error-metadata.js';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Log a failure with the same rich metadata payload that the central
 * error-handling middleware emits. Use this when you need to record an
 * error outside the middleware path (e.g. startup failures, background jobs,
 * health-check exceptions).
 *
 * The same scrubber and metadata builder are used, so the log format is
 * consistent throughout the service.
 *
 * @param logger          The Pino logger instance.
 * @param level           Pino log level (defaults to 'error' when >=500, 'warn' otherwise).
 * @param err             Any thrown value — will be wrapped via wrapUnknown if not AppError.
 * @param req             The Express request (if available). Pass a minimal stub if not.
 * @param res             The Express response (if available). Pass a minimal stub if not.
 * @param context         Additional structured context fields to merge into the log entry.
 * @param extraScrubHeaders Additional header names to redact (comma-split of config value).
 */
export function logWithMetadata(
  logger: pino.Logger,
  level: LogLevel,
  err: unknown,
  req: Request,
  res: Response,
  context: Record<string, unknown> = {},
  extraScrubHeaders: readonly string[] = [],
): void {
  const appErr = wrapUnknown(err);
  const metadata = buildErrorMetadata(appErr, req, res, extraScrubHeaders);

  logger[level]({ err: metadata, ...context }, 'Error logged with metadata');
}
