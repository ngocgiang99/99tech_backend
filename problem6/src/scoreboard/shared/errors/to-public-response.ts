import { DomainError, InternalError, ValidationError } from './domain-error';
import { defaultMessageFor } from './error-codes';

export const MESSAGE_MAX_LEN = 200;

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen) + '...';
}

export interface PublicErrorBody {
  status: number;
  body: { error: Record<string, unknown> };
}

/**
 * Build the public HTTP error envelope from scratch via an allowlist. The body
 * is NEVER produced by serialising the raw `DomainError` — that would risk
 * leaking internal fields (stack, cause, pgCode, etc).
 *
 * Rules:
 *   - `code`, `message`, `requestId` are always present
 *   - `details` is present ONLY for ValidationError when `err.details` is set
 *   - `errorId` is present ONLY when the caller passes a non-null value
 *     (the filter passes non-null only for status >= 500)
 *   - InternalError ALWAYS emits the generic message, regardless of err.message
 *     (leak prevention contract)
 *   - message is truncated to MESSAGE_MAX_LEN (200) bytes with a "..." suffix
 */
export function toPublicResponse(
  err: DomainError,
  requestId: string | null,
  errorId: string | null,
): PublicErrorBody {
  const message =
    err instanceof InternalError
      ? defaultMessageFor('INTERNAL_ERROR')
      : truncate(err.message, MESSAGE_MAX_LEN);

  const error: Record<string, unknown> = {
    code: err.code,
    message,
    requestId: requestId ?? null,
  };

  if (err instanceof ValidationError && err.details !== undefined) {
    error.details = err.details;
  }

  if (errorId !== null) {
    error.errorId = errorId;
  }

  return {
    status: err.getStatus(),
    body: { error },
  };
}
