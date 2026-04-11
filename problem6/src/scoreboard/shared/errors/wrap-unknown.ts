import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

import { InvalidArgumentError } from '../../domain/errors/invalid-argument.error';
import {
  BadRequestError,
  ConflictError,
  DependencyUnavailableError,
  DomainError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  UnprocessableEntityError,
  ValidationError,
} from './domain-error';
import { isPgError, mapDbError } from './map-db-error';

/**
 * GAP-03 / Decision 1 — Redis SPOF fail-CLOSED. When ioredis throws due to a
 * Redis outage (max-retries, connection refused/reset/timeout), every request
 * that touches Redis MUST surface as 503 TEMPORARILY_UNAVAILABLE, not 500.
 * This keeps the fail-closed contract uniform across the entire write path.
 *
 * This detection moved from error-filter.ts so that `wrapUnknown` is the single
 * point where arbitrary thrown values are classified into DomainError subclasses.
 */
export function isRedisInfrastructureError(err: Error): boolean {
  if (err.name === 'MaxRetriesPerRequestError' || err.name === 'AbortError') {
    return true;
  }
  const msg = err.message;
  return (
    msg.includes('Reached the max retries per request') ||
    msg.includes('Connection is closed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT')
  );
}

function wrapHttpException(exception: HttpException): DomainError {
  const status = exception.getStatus();
  const message = exception.message;
  const opts = { cause: exception };

  switch (status) {
    case 400:
      return new BadRequestError(message, opts);
    case 401:
      return new UnauthenticatedError(message, opts);
    case 403:
      return new ForbiddenError(message, opts);
    case 404:
      return new NotFoundError(message, opts);
    case 409:
      return new ConflictError(message, opts);
    case 422:
      return new UnprocessableEntityError(message, opts);
    case 429:
      return new RateLimitError(message, opts);
    case 503:
      return new DependencyUnavailableError(message, opts);
    default:
      if (status >= 500) {
        return new InternalError(message, opts);
      }
      return new BadRequestError(message, opts);
  }
}

function wrapZodError(exception: ZodError): ValidationError {
  const message = exception.issues.map((i) => i.message).join('; ');
  return new ValidationError(message, exception.issues);
}

/**
 * Coerce any thrown value into a DomainError, via the design.md Decision 4
 * priority chain. After this function returns, the error filter sees a
 * DomainError — always — and can take a single fall-through code path.
 */
export function wrapUnknown(exception: unknown): DomainError {
  // 1. Already a shared/errors DomainError — pass through unchanged.
  if (exception instanceof DomainError) {
    return exception;
  }

  // 2. Domain-layer InvalidArgumentError (plain Error subclass) — compat branch
  //    so the spec intent "InvalidArgumentError → ValidationError" is explicit
  //    instead of relying on the generic-Error fallback. Preserves err.message.
  if (exception instanceof InvalidArgumentError) {
    return new ValidationError(exception.message);
  }

  // 3. ZodError — validation failures from request-body parsing.
  if (exception instanceof ZodError) {
    return wrapZodError(exception);
  }

  // 4. pg-shaped errors — route through the SQLSTATE mapper.
  if (isPgError(exception)) {
    return mapDbError(exception);
  }

  // 5. Redis infrastructure errors (GAP-03 fail-CLOSED).
  if (exception instanceof Error && isRedisInfrastructureError(exception)) {
    return new DependencyUnavailableError('Service temporarily unavailable', {
      cause: exception,
    });
  }

  // 6. Any other NestJS HttpException — preserve status/message.
  if (exception instanceof HttpException) {
    return wrapHttpException(exception);
  }

  // 7. Any other Error → InternalError with original as cause.
  if (exception instanceof Error) {
    return new InternalError(exception.message, { cause: exception });
  }

  // 8. Non-Error thrown value (string, number, null, etc).
  return new InternalError('Unknown error', { cause: exception });
}
