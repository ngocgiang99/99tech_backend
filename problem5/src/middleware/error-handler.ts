import crypto from 'node:crypto';

import type { ErrorRequestHandler, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type pino from 'pino';

import { ValidationError, wrapUnknown } from '../shared/errors.js';
import { buildErrorMetadata } from '../shared/error-metadata.js';
import { toPublicResponse } from '../shared/to-public-response.js';
import type { MetricsRegistry } from '../observability/metrics-registry.js';

/** Express body-parser attaches a `type` string to parsing errors. */
interface BodyParserError extends Error {
  type?: string;
}

function normalizeBodyParserError(err: unknown): unknown {
  const e = err as BodyParserError;
  if (e?.type === 'entity.too.large') {
    return new ValidationError('Request body too large');
  }
  if (e?.type === 'entity.parse.failed') {
    return new ValidationError('Request body is not valid JSON');
  }
  return err;
}

export interface ErrorHandlerOptions {
  /** Extra header names to redact (from config.LOG_SCRUBBER_EXTRA_HEADERS). */
  extraScrubHeaders?: readonly string[];
  /** Optional metrics sink. When absent, no counter is emitted. */
  metrics?: MetricsRegistry;
}

/**
 * Central error-handling middleware.
 *
 * Responsibilities (in order):
 *  1. Guard against double-invocation via `res.headersSent` — idempotent.
 *  2. `wrapUnknown` — coerce any thrown value to a typed AppError.
 *  3. Generate a per-error `errorId` UUID for 5xx correlation.
 *  4. Build the dev-log metadata payload via `buildErrorMetadata`.
 *  5. Emit one structured log entry at `warn` (<500) or `error` (>=500).
 *  6. Increment the `errors_total{code,status}` counter if a registry is supplied.
 *  7. Build the minimal public response via `toPublicResponse` and send it.
 */
export function createErrorHandler(
  logger: pino.Logger,
  opts: ErrorHandlerOptions = {},
): ErrorRequestHandler {
  const { extraScrubHeaders = [], metrics } = opts;

  return function errorHandler(err, req, res, _next) {
    // Idempotency guard — if a response has already started (e.g. next(err)
    // was called twice), do nothing. Logging and responding twice would be
    // confusing and potentially break the HTTP stream.
    if (res.headersSent) return;

    // 1. Normalize body-parser errors to typed ValidationErrors, then wrap.
    const appErr = wrapUnknown(normalizeBodyParserError(err));

    // 2. Per-error correlation id — only included in public response for 5xx.
    const errorId = crypto.randomUUID();

    // 3. Build the full dev-log payload (scrubbed headers, cause chain, etc.)
    // Pass errorId so the log entry and the public response share the same UUID.
    const metadata = buildErrorMetadata(appErr, req as ExpressRequest, res as ExpressResponse, extraScrubHeaders, errorId);

    // 4. Log at the appropriate level.
    if (appErr.status >= 500) {
      logger.error({ err: metadata }, 'Request error');
    } else {
      logger.warn({ err: metadata }, 'Request error');
    }

    // 5. Optionally emit metrics.
    metrics?.errorsTotal.inc({
      code: appErr.code,
      status: String(appErr.status),
    });

    // 6. Build and send the minimal public response.
    const { status, body } = toPublicResponse(
      appErr,
      (req as { id?: string }).id ?? 'unknown',
      appErr.status >= 500 ? errorId : null,
    );

    res.status(status).json(body);
  };
}
