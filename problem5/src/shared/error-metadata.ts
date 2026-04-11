import crypto from 'node:crypto';

import type { Request, Response } from 'express';

import { AppError } from './errors.js';
import { scrubHeaders } from './sanitizer.js';

/**
 * Route extraction: duplicated inline from src/observability/http-metrics.ts so
 * that src/shared/ does not depend on src/observability/.
 */
function extractRoutePath(req: { route?: unknown; baseUrl?: unknown }): string {
  const route = req.route;
  if (route === null || typeof route !== 'object') return '__unmatched';
  const path: unknown = (route as { path?: unknown }).path;
  if (typeof path !== 'string') return '__unmatched';

  const baseUrl: unknown = req.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return path;

  if (path === '/') return baseUrl;
  return baseUrl + path;
}

/** A single entry in the walked cause chain. */
export interface CauseEntry {
  class: string;
  message: string;
}

/** The full dev-log metadata payload produced for every error that hits the handler. */
export interface ErrorMetadata {
  errorId: string;
  errorClass: string;
  code: string;
  status: number;
  message: string;
  stack: string | undefined;
  /** pgCode is present when the error originated from impl-db's mapper. */
  pgCode: string | undefined;
  cause: CauseEntry[];
  requestId: string;
  method: string;
  route: string;
  headers: Record<string, unknown>;
  query: string;
  body: {
    size: number | null;
    contentType: string | null;
  };
  userAgent: string | null;
  remoteAddr: string | null;
  timestamp: string;
}

const MAX_CAUSE_DEPTH = 5;
const MAX_QUERY_BYTES = 2048;

/** Walk the Error.cause chain up to MAX_CAUSE_DEPTH, stopping at the first non-Error. */
function walkCause(err: unknown, depth = 0): CauseEntry[] {
  if (depth >= MAX_CAUSE_DEPTH) return [];
  if (!(err instanceof Error)) return [];

  const entry: CauseEntry = {
    class: err.constructor.name,
    message: err.message,
  };

  const rest = 'cause' in err ? walkCause(err.cause, depth + 1) : [];
  return [entry, ...rest];
}

/**
 * Build the structured dev-log metadata payload for an error that reached the
 * error-handling middleware. This is the single source of truth for what
 * information is included in each error log entry.
 *
 * The returned object is safe to serialize to JSON and emit as a Pino log field.
 * Body content is NEVER included — only `body.size` and `body.contentType`.
 * Request headers are scrubbed via the default denylist + optional extra denylist.
 *
 * @param err           The (possibly wrapped) AppError.
 * @param req           The Express request.
 * @param _res          The Express response (reserved for future fields such as duration).
 * @param extraDenylist Additional header names to redact (from config.LOG_SCRUBBER_EXTRA_HEADERS).
 * @param errorId       Pre-generated errorId UUID. When supplied (from the error handler), the log
 *                      entry and the public response share the same id. Defaults to a fresh UUID.
 */
export function buildErrorMetadata(
  err: AppError,
  req: Request,
  _res: Response,
  extraDenylist: readonly string[] = [],
  errorId: string = crypto.randomUUID(),
): ErrorMetadata {
  const requestId = (req as { id?: string }).id ?? 'unknown';

  // Cause chain: start from err.cause (not err itself) — err is already captured
  // by errorClass/code/message/stack above.
  const cause = 'cause' in err ? walkCause(err.cause) : [];

  // Scrub headers before logging. Guard against null/undefined in unit tests
  // where mock requests may omit the headers object entirely.
  const rawHeaders = (req.headers ?? {}) as Record<string, unknown>;
  const headers = scrubHeaders(rawHeaders, extraDenylist);

  // Query string: cap at 2KB to prevent log bloat from enormous query strings.
  const rawQuery = req.url?.split('?')[1] ?? '';
  const query =
    rawQuery.length > MAX_QUERY_BYTES
      ? rawQuery.slice(0, MAX_QUERY_BYTES) + '...'
      : rawQuery;

  // Body: size from Content-Length header (NEVER the body content itself).
  // Use optional chaining so this is safe even when req.headers is undefined
  // (e.g. in legacy unit tests that construct minimal mock requests).
  const reqHeaders = req.headers ?? {};
  const contentLengthHeader = reqHeaders['content-length'];
  const bodySize =
    typeof contentLengthHeader === 'string' && contentLengthHeader.length > 0
      ? parseInt(contentLengthHeader, 10)
      : null;
  const contentTypeHeader = reqHeaders['content-type'];
  const bodyContentType =
    typeof contentTypeHeader === 'string' && contentTypeHeader.length > 0
      ? contentTypeHeader
      : null;

  // pgCode: non-public property set by the infrastructure DB error mapper.
  const pgCode = (err as { pgCode?: string }).pgCode;

  return {
    errorId,
    errorClass: err.constructor.name,
    code: err.code,
    status: err.status,
    message: err.message,
    stack: err.stack,
    pgCode: typeof pgCode === 'string' ? pgCode : undefined,
    cause,
    requestId,
    method: req.method,
    route: extractRoutePath(req),
    headers,
    query,
    body: {
      size: bodySize !== null && !isNaN(bodySize) ? bodySize : null,
      contentType: bodyContentType,
    },
    userAgent: reqHeaders['user-agent'] ?? null,
    remoteAddr:
      req.ip ??
      (req.socket?.remoteAddress ?? null),
    timestamp: new Date().toISOString(),
  };
}
