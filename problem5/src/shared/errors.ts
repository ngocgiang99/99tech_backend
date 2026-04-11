import {
  type ErrorCode,
  ERROR_CODE_META,
} from './error-codes.js';

export { type ErrorCode } from './error-codes.js';

/**
 * Base class for all application errors.
 *
 * Carry a stable `code` (from the ErrorCode union), the canonical HTTP `status`,
 * a safe public `message`, optional structured `details`, and an optional `cause`
 * for wrapping lower-level errors without losing the chain.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  override readonly message: string;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { details?: unknown; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.status = ERROR_CODE_META[code].status;
    this.message = message;
    if (opts?.details !== undefined) {
      this.details = opts.details;
    }
    if (opts?.cause !== undefined) {
      this.cause = opts.cause;
    }
  }

  get [Symbol.toStringTag](): string {
    return this.name;
  }
}

export class ValidationError extends AppError {
  constructor(message?: string, details?: unknown) {
    super(
      'VALIDATION',
      message ?? ERROR_CODE_META.VALIDATION.defaultMessage,
      ...(details !== undefined ? [{ details }] : []),
    );
  }

  override get [Symbol.toStringTag](): string {
    return 'ValidationError';
  }
}

export class BadRequestError extends AppError {
  constructor(message?: string, opts?: { details?: unknown; cause?: unknown }) {
    super('BAD_REQUEST', message ?? ERROR_CODE_META.BAD_REQUEST.defaultMessage, opts);
  }

  override get [Symbol.toStringTag](): string {
    return 'BadRequestError';
  }
}

export class NotFoundError extends AppError {
  constructor(message?: string) {
    super('NOT_FOUND', message ?? ERROR_CODE_META.NOT_FOUND.defaultMessage);
  }

  override get [Symbol.toStringTag](): string {
    return 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message?: string, opts?: { details?: unknown; cause?: unknown }) {
    super('CONFLICT', message ?? ERROR_CODE_META.CONFLICT.defaultMessage, opts);
  }

  override get [Symbol.toStringTag](): string {
    return 'ConflictError';
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message?: string, opts?: { details?: unknown; cause?: unknown }) {
    super(
      'UNPROCESSABLE_ENTITY',
      message ?? ERROR_CODE_META.UNPROCESSABLE_ENTITY.defaultMessage,
      opts,
    );
  }

  override get [Symbol.toStringTag](): string {
    return 'UnprocessableEntityError';
  }
}

export class RateLimitError extends AppError {
  constructor(message?: string, opts?: { details?: unknown; cause?: unknown }) {
    super('RATE_LIMIT', message ?? ERROR_CODE_META.RATE_LIMIT.defaultMessage, opts);
  }

  override get [Symbol.toStringTag](): string {
    return 'RateLimitError';
  }
}

export class DependencyError extends AppError {
  constructor(message?: string, opts?: { details?: unknown; cause?: unknown }) {
    super(
      'DEPENDENCY_UNAVAILABLE',
      message ?? ERROR_CODE_META.DEPENDENCY_UNAVAILABLE.defaultMessage,
      opts,
    );
  }

  override get [Symbol.toStringTag](): string {
    return 'DependencyError';
  }
}

export class InternalError extends AppError {
  constructor(message?: string, opts?: { details?: unknown; cause?: unknown }) {
    super('INTERNAL_ERROR', message ?? ERROR_CODE_META.INTERNAL_ERROR.defaultMessage, opts);
  }

  override get [Symbol.toStringTag](): string {
    return 'InternalError';
  }
}

/**
 * Pass-through if `err` is already an AppError; otherwise wraps it in an
 * InternalError with the original attached as `cause`.
 */
export function wrapUnknown(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }
  return new InternalError(undefined, { cause: err });
}
