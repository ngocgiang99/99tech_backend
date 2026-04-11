import type { FastifyRequest } from 'fastify';

import { UnauthenticatedError } from '../../shared/errors';

/**
 * A FastifyRequest that has been authenticated by JwtGuard. The guard attaches
 * a `userId` string to the request object; downstream handlers read it via
 * {@link getAuthenticatedUserId} which enforces the invariant at runtime.
 *
 * Controllers SHOULD type their `@Req()` parameter as this interface instead
 * of `Record<string, unknown>` so the `userId` attachment is explicit.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  userId?: unknown;
}

/**
 * Read the authenticated userId off a request. Throws UnauthenticatedError if
 * the guard pipeline failed to attach one (defensive — this should only happen
 * if a handler forgot `@UseGuards(JwtGuard)`).
 */
export function getAuthenticatedUserId(req: AuthenticatedRequest): string {
  const userId = req.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UnauthenticatedError('Unauthorized');
  }
  return userId;
}

/**
 * Read an optional userId — used by the SSE controller's slow-client warning
 * log where the userId is informational and a missing value just logs as
 * `undefined` rather than throwing.
 */
export function peekAuthenticatedUserId(
  req: AuthenticatedRequest,
): string | undefined {
  const userId = req.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
}
