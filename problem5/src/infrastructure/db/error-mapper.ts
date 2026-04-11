import {
  AppError,
  ConflictError,
  DependencyError,
  InternalError,
  ValidationError,
} from '../../shared/errors.js';

/**
 * Structural type guard for pg-shaped errors.
 *
 * We use a structural check rather than `instanceof pg.DatabaseError`
 * because `pg.DatabaseError` isn't always exported cleanly depending on
 * the driver version and how it's bundled.  A pg error always has a string
 * `code` property (the SQLSTATE) and either `name === 'error'` or
 * `name === 'DatabaseError'`.
 */
function isPgError(err: unknown): err is { code: string; message: string; column?: string } {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e['code'] === 'string' && (e['name'] === 'error' || e['name'] === 'DatabaseError');
}

/**
 * Attach the raw pg SQLSTATE code as a non-enumerable property so that
 * the error metadata builder (Wave 2) can include it in dev-log payloads
 * without polluting JSON serialization or public response bodies.
 */
function attachPgCode(appErr: AppError, pgCode: string): void {
  Object.defineProperty(appErr, 'pgCode', {
    value: pgCode,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Map a raw database error to a typed `AppError` subclass.
 *
 * Postgres error codes handled:
 *   23505  unique violation          → ConflictError (409)
 *   23502  not-null violation        → ValidationError (400), details includes column name
 *   23503  foreign key violation     → ValidationError (400)
 *   22001  string data right trunc   → ValidationError (400)
 *   40P01  deadlock detected         → DependencyError (503)
 *   57014  query canceled            → DependencyError (503)
 *   53300  too many connections      → DependencyError (503)
 *   *      any other pg code         → InternalError (500), original as cause
 *   non-pg error                     → InternalError (500), original as cause
 */
export function mapDbError(err: unknown): AppError {
  if (!isPgError(err)) {
    return new InternalError(undefined, { cause: err });
  }

  const { code, column } = err;
  let mapped: AppError;

  switch (code) {
    case '23505': {
      mapped = new ConflictError(undefined, { cause: err });
      break;
    }
    case '23502': {
      const details = column != null ? [{ path: column, code: 'not_null', message: `Column "${column}" cannot be null` }] : undefined;
      mapped = new ValidationError('Not-null constraint violation', details);
      break;
    }
    case '23503': {
      mapped = new ValidationError('Foreign key constraint violation');
      break;
    }
    case '22001': {
      mapped = new ValidationError('Value too long for column');
      break;
    }
    case '40P01': {
      mapped = new DependencyError('Deadlock detected — please retry', { cause: err });
      break;
    }
    case '57014': {
      mapped = new DependencyError('Query canceled due to timeout', { cause: err });
      break;
    }
    case '53300': {
      mapped = new DependencyError('Too many database connections', { cause: err });
      break;
    }
    default: {
      mapped = new InternalError(undefined, { cause: err });
      break;
    }
  }

  // Expose the raw pg code on ALL mapped errors (not just InternalError) so
  // the Wave 2 metadata builder can log it for debugging.
  attachPgCode(mapped, code);

  return mapped;
}
