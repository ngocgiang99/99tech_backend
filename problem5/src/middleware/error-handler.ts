import type { ErrorRequestHandler } from 'express';
import type pino from 'pino';

export interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
}

export function createErrorHandler(logger: pino.Logger): ErrorRequestHandler {
  return function errorHandler(err, req, res, _next) {
    const httpErr = err as HttpError;
    const requestId = req.id ?? 'unknown';
    const status = httpErr.status ?? httpErr.statusCode ?? 500;
    const code = httpErr.code ?? 'INTERNAL_ERROR';
    const message =
      status === 500 ? 'Internal Server Error' : (httpErr.message ?? 'An error occurred');

    logger.error(
      {
        err: httpErr,
        requestId,
        method: req.method,
        url: req.url,
        status,
      },
      'Request error',
    );

    res.status(status).json({
      error: {
        code,
        message,
        requestId,
      },
    });
  };
}
