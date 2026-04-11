/**
 * ERROR_CODES — the complete set of machine-readable error codes emitted by the
 * scoreboard module's HTTP surface. This is the single source of truth for
 * code-to-status mapping; every DomainError subclass derives its HTTP status
 * from ERROR_CODE_META[code].status, never hard-coded.
 *
 * Adding a new code:
 *   1. Append the string to this tuple.
 *   2. Add an entry to ERROR_CODE_META.
 *   3. Create the matching DomainError subclass in ./domain-error.ts.
 *   TypeScript's exhaustiveness check will flag any step you miss.
 */
export const ERROR_CODES = [
  'VALIDATION',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMIT',
  'TEMPORARILY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorCodeMetaEntry {
  readonly status: number;
  readonly defaultMessage: string;
}

export const ERROR_CODE_META: Record<ErrorCode, ErrorCodeMetaEntry> = {
  VALIDATION: { status: 400, defaultMessage: 'Validation failed' },
  BAD_REQUEST: { status: 400, defaultMessage: 'Bad request' },
  UNAUTHENTICATED: { status: 401, defaultMessage: 'Authentication required' },
  FORBIDDEN: { status: 403, defaultMessage: 'Forbidden' },
  NOT_FOUND: { status: 404, defaultMessage: 'Resource not found' },
  CONFLICT: { status: 409, defaultMessage: 'Conflict' },
  UNPROCESSABLE_ENTITY: {
    status: 422,
    defaultMessage: 'Unprocessable entity',
  },
  RATE_LIMIT: { status: 429, defaultMessage: 'Too many requests' },
  TEMPORARILY_UNAVAILABLE: {
    status: 503,
    defaultMessage: 'Service temporarily unavailable',
  },
  INTERNAL_ERROR: { status: 500, defaultMessage: 'Internal server error' },
};

export function errorStatusFor(code: ErrorCode): number {
  return ERROR_CODE_META[code].status;
}

export function defaultMessageFor(code: ErrorCode): string {
  return ERROR_CODE_META[code].defaultMessage;
}
