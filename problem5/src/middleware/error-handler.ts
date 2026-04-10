import type { ErrorRequestHandler } from 'express';
import type pino from 'pino';

import { AppError } from '../lib/errors.js';

export interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
  type?: string;
}

export function createErrorHandler(logger: pino.Logger): ErrorRequestHandler {
  return function errorHandler(err, req, res, _next) {
    const requestId = req.id ?? 'unknown';

    // Handle AppError subclasses (ValidationError, NotFoundError, ConflictError)
    if (err instanceof AppError) {
      logger.warn(
        { err, requestId, method: req.method, url: req.url, status: err.status },
        'Request error',
      );

      const body: Record<string, unknown> = {
        code: err.code,
        message: err.message,
        requestId,
      };
      if (err.details !== undefined) {
        body['details'] = err.details;
      }

      res.status(err.status).json({ error: body });
      return;
    }

    // Handle Express body-parser errors (oversized payloads, malformed JSON)
    const httpErr = err as HttpError;
    if (httpErr.type === 'entity.too.large') {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Request body too large',
          requestId,
        },
      });
      return;
    }
    if (httpErr.type === 'entity.parse.failed') {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Request body is not valid JSON',
          requestId,
        },
      });
      return;
    }

    // Generic 500
    const status = httpErr.status ?? httpErr.statusCode ?? 500;
    const code = httpErr.code ?? 'INTERNAL_ERROR';

    logger.error(
      { err: httpErr, requestId, method: req.method, url: req.url, status },
      'Request error',
    );

    res.status(status).json({
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : code,
        message: status === 500 ? 'Internal Server Error' : (httpErr.message ?? 'An error occurred'),
        requestId,
      },
    });
  };
}
