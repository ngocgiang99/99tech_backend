import { AppError, InternalError, ValidationError } from './errors.js';
import { ERROR_CODE_META } from './error-codes.js';

/**
 * Truncate a string to at most `maxLen` characters.
 * If the string is longer, it is cut at `maxLen` chars and "..." is appended,
 * resulting in a final length of `maxLen + 3`.
 *
 * Example: truncate("abc", 2) → "ab..."
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

const MESSAGE_MAX_LEN = 200;

/**
 * Build the minimal-allowlist public error response body.
 *
 * The body is constructed from scratch — it NEVER serializes the underlying error
 * object, so no internal field can accidentally leak into the response.
 *
 * Rules:
 * - `code`      — always present; the stable ErrorCode string.
 * - `message`   — always present; truncated to 200 chars. For InternalError,
 *                 ALWAYS the generic "Internal server error" regardless of err.message.
 * - `requestId` — always present.
 * - `details`   — present ONLY for ValidationError; copied from err.details.
 * - `errorId`   — present ONLY when errorId param is non-null (caller passes
 *                 non-null only for status >= 500).
 */
export function toPublicResponse(
  err: AppError,
  requestId: string,
  errorId: string | null,
): { status: number; body: unknown } {
  // InternalError always uses the generic message — leak prevention guarantee.
  const rawMessage =
    err instanceof InternalError
      ? ERROR_CODE_META.INTERNAL_ERROR.defaultMessage
      : err.message;

  const message = truncate(rawMessage, MESSAGE_MAX_LEN);

  const error: Record<string, unknown> = {
    code: err.code,
    message,
    requestId,
  };

  // details only for ValidationError
  if (err instanceof ValidationError && err.details !== undefined) {
    error['details'] = err.details;
  }

  // errorId only for 5xx (caller controls this via null/non-null)
  if (errorId !== null) {
    error['errorId'] = errorId;
  }

  return {
    status: err.status,
    body: { error },
  };
}
