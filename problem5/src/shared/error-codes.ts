/**
 * Stable, machine-readable error code enum.
 *
 * Add new codes at the end of the tuple; never remove or rename existing ones
 * without a deprecation cycle — clients may depend on them.
 */
export const ERROR_CODES = [
  'VALIDATION',
  'BAD_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMIT',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Maps each ErrorCode to its canonical HTTP status and a generic default message.
 * Subclasses derive their defaults from this map so there is a single source of truth.
 */
export const ERROR_CODE_META: Record<ErrorCode, { status: number; defaultMessage: string }> = {
  VALIDATION: { status: 400, defaultMessage: 'Request validation failed' },
  BAD_REQUEST: { status: 400, defaultMessage: 'Bad request' },
  NOT_FOUND: { status: 404, defaultMessage: 'Resource not found' },
  CONFLICT: { status: 409, defaultMessage: 'Resource conflict' },
  UNPROCESSABLE_ENTITY: { status: 422, defaultMessage: 'Unprocessable entity' },
  RATE_LIMIT: { status: 429, defaultMessage: 'Too many requests' },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    defaultMessage: 'Upstream dependency is temporarily unavailable',
  },
  INTERNAL_ERROR: { status: 500, defaultMessage: 'Internal server error' },
};

/** Returns the canonical HTTP status code for a given ErrorCode. */
export function errorStatusFor(code: ErrorCode): number {
  return ERROR_CODE_META[code].status;
}

/** Returns the default human-readable message for a given ErrorCode. */
export function defaultMessageFor(code: ErrorCode): string {
  return ERROR_CODE_META[code].defaultMessage;
}
