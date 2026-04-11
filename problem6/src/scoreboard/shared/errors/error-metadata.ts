import type { FastifyRequest } from 'fastify';

import type { DomainError } from './domain-error';
import type { ErrorCode } from './error-codes';
import { scrubHeaders } from './scrub-headers';

export const MAX_CAUSE_DEPTH = 5;
export const MAX_QUERY_BYTES = 2048;

export interface CauseEntry {
  class: string;
  message: string;
}

export interface ErrorMetadata {
  errorId: string;
  errorClass: string;
  code: ErrorCode;
  status: number;
  message: string;
  stack?: string;
  pgCode?: string;
  cause: CauseEntry[];
  requestId: string | null;
  method: string;
  route: string;
  headers: Record<string, unknown>;
  query: string;
  body: { size: number | null; contentType: string | null };
  userAgent: string | null;
  remoteAddr: string | null;
  timestamp: string;
}

/**
 * Walk `err.cause` up to MAX_CAUSE_DEPTH levels, capturing only {class, message}
 * per level. Stops on a non-Error cause. Does NOT include the top-level error
 * itself — `buildErrorMetadata` captures that as `errorClass` / `message`.
 */
export function walkCause(err: unknown, depth = 0): CauseEntry[] {
  if (depth >= MAX_CAUSE_DEPTH) {
    return [];
  }
  if (!(err instanceof Error)) {
    return [];
  }
  const inner = (err as { cause?: unknown }).cause;
  if (!(inner instanceof Error)) {
    return [];
  }
  const entry: CauseEntry = {
    class: inner.constructor.name,
    message: inner.message,
  };
  return [entry, ...walkCause(inner, depth + 1)];
}

function capQuery(query: string): string {
  if (query.length <= MAX_QUERY_BYTES) {
    return query;
  }
  return query.slice(0, MAX_QUERY_BYTES) + '...';
}

function extractQuery(request: FastifyRequest): string {
  // Prefer a raw query string from the URL if available; Fastify's `query`
  // field is already parsed to an object.
  const url = request.url ?? '';
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    return url.slice(qIdx + 1);
  }
  return '';
}

function extractHeaderString(
  headers: Record<string, unknown>,
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function extractBody(headers: Record<string, unknown>): {
  size: number | null;
  contentType: string | null;
} {
  const contentLength = extractHeaderString(headers, 'content-length');
  const size = contentLength !== null ? Number(contentLength) : null;
  return {
    size: size !== null && Number.isFinite(size) ? size : null,
    contentType: extractHeaderString(headers, 'content-type'),
  };
}

/**
 * Context shape for a non-HTTP error path (background worker, message handler,
 * shutdown hook, scheduled job). Supplied by `buildBackgroundErrorMetadata` to
 * populate the same metadata envelope as the HTTP path without fabricating a
 * Fastify request.
 */
export interface BackgroundContext {
  /** Logical source identifier — becomes `route`, e.g. 'outbox-publisher'. */
  source?: string;
}

interface MetadataSource {
  requestId: string | null;
  method: string;
  route: string;
  rawHeaders: Record<string, unknown>;
  query: string;
  userAgent: string | null;
  remoteAddr: string | null;
}

function sourceFromRequest(
  request: FastifyRequest & { requestId?: string },
): MetadataSource {
  const rawHeaders = (request.headers ?? {}) as Record<string, unknown>;
  const query = capQuery(extractQuery(request));
  const userAgent = extractHeaderString(rawHeaders, 'user-agent');
  const remoteAddr =
    (request as { ip?: string }).ip ??
    (request as { socket?: { remoteAddress?: string } }).socket
      ?.remoteAddress ??
    null;
  const route =
    (request as { routeOptions?: { url?: string } }).routeOptions?.url ??
    request.url ??
    '__unmatched';
  return {
    requestId: request.requestId ?? null,
    method: request.method ?? 'UNKNOWN',
    route,
    rawHeaders,
    query,
    userAgent,
    remoteAddr,
  };
}

function sourceFromBackground(context: BackgroundContext): MetadataSource {
  return {
    requestId: null,
    method: 'BACKGROUND',
    route: context.source ?? '__background',
    rawHeaders: {},
    query: '',
    userAgent: null,
    remoteAddr: null,
  };
}

function buildFromSource(
  err: DomainError,
  src: MetadataSource,
  errorId: string,
): ErrorMetadata {
  const scrubbed = scrubHeaders(src.rawHeaders);
  const body = extractBody(src.rawHeaders);

  const metadata: ErrorMetadata = {
    errorId,
    errorClass: err.constructor.name,
    code: err.code,
    status: err.getStatus(),
    message: err.message,
    cause: walkCause(err),
    requestId: src.requestId,
    method: src.method,
    route: src.route,
    headers: scrubbed,
    query: src.query,
    body,
    userAgent: src.userAgent,
    remoteAddr: src.remoteAddr,
    timestamp: new Date().toISOString(),
  };

  if (err.stack !== undefined) {
    metadata.stack = err.stack;
  }
  const pgCode = (err as { pgCode?: string }).pgCode;
  if (typeof pgCode === 'string') {
    metadata.pgCode = pgCode;
  }

  return metadata;
}

/**
 * Build the structured error metadata object used as the first argument of
 * `logger.error(obj, msg)` on the HTTP path. Captures the full cause chain,
 * scrubbed headers, query string (capped at 2KB), request body metadata (size
 * + content-type only — NEVER body content), userAgent, remoteAddr, timestamp,
 * and the non-enumerable `pgCode` if `mapDbError()` attached one.
 */
export function buildErrorMetadata(
  err: DomainError,
  request: FastifyRequest & { requestId?: string },
  errorId: string,
): ErrorMetadata {
  return buildFromSource(err, sourceFromRequest(request), errorId);
}

/**
 * Build the same structured metadata envelope for a non-HTTP error path. The
 * `method` becomes `'BACKGROUND'` and the `route` defaults to `'__background'`
 * unless `context.source` is supplied. Headers/query/userAgent/remoteAddr are
 * empty or null — background errors have no inbound request.
 */
export function buildBackgroundErrorMetadata(
  err: DomainError,
  context: BackgroundContext,
  errorId: string,
): ErrorMetadata {
  return buildFromSource(err, sourceFromBackground(context), errorId);
}
