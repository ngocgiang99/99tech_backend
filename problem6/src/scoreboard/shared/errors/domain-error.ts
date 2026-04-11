import { HttpException } from '@nestjs/common';

import {
  ERROR_CODE_META,
  type ErrorCode,
  defaultMessageFor,
} from './error-codes';

export interface DomainErrorOptions {
  details?: unknown;
  cause?: unknown;
}

/**
 * DomainError — abstract base for every typed error the scoreboard module throws.
 * Extends NestJS HttpException so guards/pipes/filters treat it identically to
 * the framework's built-in exceptions, while carrying a stable machine-readable
 * `code`, optional structured `details`, and an optional `cause` chain.
 *
 * The HttpException response payload is set to `{ code, message }` so that if a
 * downstream consumer ever calls `getResponse()` it gets a sane shape — but the
 * scoreboard error filter NEVER reads via `getResponse()`; it reads the
 * instance fields directly.
 */
export abstract class DomainError extends HttpException {
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  protected constructor(
    code: ErrorCode,
    message: string,
    opts?: DomainErrorOptions,
  ) {
    super(
      { code, message },
      ERROR_CODE_META[code].status,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = this.constructor.name;
    this.code = code;
    if (opts?.details !== undefined) {
      (this as { details?: unknown }).details = opts.details;
    }
  }
}

// ─── Concrete subclasses ────────────────────────────────────────────────────

export class ValidationError extends DomainError {
  constructor(message?: string, details?: unknown) {
    super(
      'VALIDATION',
      message ?? defaultMessageFor('VALIDATION'),
      details !== undefined ? { details } : undefined,
    );
  }
}

export class BadRequestError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super('BAD_REQUEST', message ?? defaultMessageFor('BAD_REQUEST'), opts);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super(
      'UNAUTHENTICATED',
      message ?? defaultMessageFor('UNAUTHENTICATED'),
      opts,
    );
  }
}

export class ForbiddenError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super('FORBIDDEN', message ?? defaultMessageFor('FORBIDDEN'), opts);
  }
}

export class NotFoundError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super('NOT_FOUND', message ?? defaultMessageFor('NOT_FOUND'), opts);
  }
}

export class ConflictError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super('CONFLICT', message ?? defaultMessageFor('CONFLICT'), opts);
  }
}

export class UnprocessableEntityError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super(
      'UNPROCESSABLE_ENTITY',
      message ?? defaultMessageFor('UNPROCESSABLE_ENTITY'),
      opts,
    );
  }
}

export class RateLimitError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super('RATE_LIMIT', message ?? defaultMessageFor('RATE_LIMIT'), opts);
  }
}

export class DependencyUnavailableError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super(
      'TEMPORARILY_UNAVAILABLE',
      message ?? defaultMessageFor('TEMPORARILY_UNAVAILABLE'),
      opts,
    );
  }
}

export class InternalError extends DomainError {
  constructor(message?: string, opts?: DomainErrorOptions) {
    super(
      'INTERNAL_ERROR',
      message ?? defaultMessageFor('INTERNAL_ERROR'),
      opts,
    );
  }
}
