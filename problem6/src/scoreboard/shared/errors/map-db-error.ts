import {
  ConflictError,
  DependencyUnavailableError,
  DomainError,
  InternalError,
  ValidationError,
} from './domain-error';

export interface PgLikeError {
  code: string;
  message: string;
  column?: string;
  name?: string;
}

/**
 * Structural type-guard for pg-shaped errors. We deliberately avoid importing
 * from `pg` so that the shared/errors module has no hard dependency on the
 * Postgres client — the package boundary via Kysely is lossy and a runtime
 * shape check is more reliable than `instanceof pg.DatabaseError`.
 */
export function isPgError(err: unknown): err is PgLikeError {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { code?: unknown; name?: unknown };
  if (typeof candidate.code !== 'string') {
    return false;
  }
  return candidate.name === 'error' || candidate.name === 'DatabaseError';
}

/**
 * Attach the raw Postgres SQLSTATE onto a DomainError as a non-enumerable
 * property so the metadata builder can log it without it leaking into
 * `JSON.stringify(err)` or the public response envelope.
 */
export function attachPgCode(appErr: DomainError, pgCode: string): void {
  Object.defineProperty(appErr, 'pgCode', {
    value: pgCode,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Map an unknown thrown value (expected to be a pg-shaped error) to a typed
 * DomainError. Handles seven explicit SQLSTATE codes; anything else falls
 * through to InternalError. Non-pg values also become InternalError with the
 * original preserved as cause.
 */
export function mapDbError(err: unknown): DomainError {
  if (!isPgError(err)) {
    return new InternalError('Database error', { cause: err });
  }

  let mapped: DomainError;
  switch (err.code) {
    case '23505':
      mapped = new ConflictError(err.message || 'Unique constraint violation', {
        cause: err,
      });
      break;
    case '23502': {
      const details = err.column ? { column: err.column } : undefined;
      mapped = new ValidationError(
        err.message || 'Not-null constraint violation',
        details,
      );
      (mapped as { cause?: unknown }).cause = err;
      break;
    }
    case '23503':
      mapped = new ValidationError(
        err.message || 'Foreign key constraint violation',
      );
      (mapped as { cause?: unknown }).cause = err;
      break;
    case '22001':
      mapped = new ValidationError(
        err.message || 'Value too long for column type',
      );
      (mapped as { cause?: unknown }).cause = err;
      break;
    case '40P01':
      mapped = new DependencyUnavailableError(
        err.message || 'Deadlock detected',
        { cause: err },
      );
      break;
    case '57014':
      mapped = new DependencyUnavailableError(
        err.message || 'Query cancelled',
        { cause: err },
      );
      break;
    case '53300':
      mapped = new DependencyUnavailableError(
        err.message || 'Too many database connections',
        { cause: err },
      );
      break;
    default:
      mapped = new InternalError('Database error', { cause: err });
  }

  attachPgCode(mapped, err.code);
  return mapped;
}
