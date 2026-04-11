import { ExecutionContext } from '@nestjs/common';

// ---------------------------------------------------------------------------
// We import the guard module directly. Each `jest.resetModules()` + fresh
// `require` gives us a new module instance with globalCount = 0.
// ---------------------------------------------------------------------------

function buildCtx(userId: string | undefined): ExecutionContext {
  const request: Record<string, unknown> = { userId };
  const response = { header: jest.fn() };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function makeConfig(rateLimitPerSec: number) {
  return { get: jest.fn().mockReturnValue(rateLimitPerSec) };
}

function makeBucket(result: { allowed: boolean; retryAfterMs?: number }) {
  return { consume: jest.fn().mockResolvedValue(result) };
}

// ---------------------------------------------------------------------------
// Helper: fresh require to reset module-level globalCount
// ---------------------------------------------------------------------------
function freshGuard() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../../src/scoreboard/infrastructure/rate-limit/rate-limit.guard') as typeof import('../../../src/scoreboard/infrastructure/rate-limit/rate-limit.guard');
  return mod.RateLimitGuard;
}

// Helper: catch an error from a promise and return it
async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (err) {
    return err as Error;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimitGuard', () => {
  describe('happy path', () => {
    it('returns true when bucket allows the request', async () => {
      const Guard = await freshGuard();
      const bucket = makeBucket({ allowed: true });
      const config = makeConfig(10);
      const guard = new Guard(bucket as never, config as never);

      const result = await guard.canActivate(buildCtx('user-1'));

      expect(result).toBe(true);
      expect(bucket.consume).toHaveBeenCalledWith('user-1', 20, 10);
    });
  });

  describe('reject path (429)', () => {
    it('throws 429 and sets Retry-After header when bucket rejects', async () => {
      const Guard = await freshGuard();
      const bucket = makeBucket({ allowed: false, retryAfterMs: 500 });
      const config = makeConfig(10);
      const guard = new Guard(bucket as never, config as never);

      const ctx = buildCtx('user-2');
      const response = ctx.switchToHttp().getResponse() as { header: jest.Mock };

      const err = await catchError(guard.canActivate(ctx));
      expect(err).toHaveProperty('getStatus');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ex = err as any;
      expect(ex.getStatus()).toBe(429);
      expect(ex.getResponse().code).toBe('RATE_LIMITED');
      expect(response.header).toHaveBeenCalledWith('Retry-After', '1');
    });

    it('defaults Retry-After to 1 second when retryAfterMs is undefined', async () => {
      const Guard = await freshGuard();
      const bucket = makeBucket({ allowed: false });
      const config = makeConfig(10);
      const guard = new Guard(bucket as never, config as never);

      const ctx = buildCtx('user-3');
      const response = ctx.switchToHttp().getResponse() as { header: jest.Mock };

      const err = await catchError(guard.canActivate(ctx));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((err as any).getStatus()).toBe(429);
      expect(response.header).toHaveBeenCalledWith('Retry-After', '1');
    });
  });

  describe('wiring guard (missing userId)', () => {
    it('throws an error when userId is undefined (JwtGuard not wired)', async () => {
      const Guard = await freshGuard();
      const bucket = makeBucket({ allowed: true });
      const config = makeConfig(10);
      const guard = new Guard(bucket as never, config as never);

      const err = await catchError(guard.canActivate(buildCtx(undefined)));
      expect(err.message).toContain('JwtGuard must run first');
    });
  });

  describe('global circuit breaker (503)', () => {
    it('throws 503 after more than 5000 calls within the same second', async () => {
      const Guard = await freshGuard();
      // Use a bucket that always admits, so the guard reaches the count check
      const bucket = makeBucket({ allowed: true });
      const config = makeConfig(10);
      const guard = new Guard(bucket as never, config as never);

      const ctx = buildCtx('user-circuit');

      // Fire 5000 successful requests
      for (let i = 0; i < 5000; i++) {
        await guard.canActivate(ctx);
      }

      // The 5001st should trip the breaker
      const err = await catchError(guard.canActivate(ctx));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ex = err as any;
      expect(ex.getStatus()).toBe(503);
      expect(ex.getResponse().code).toBe('TEMPORARILY_UNAVAILABLE');
    });
  });
});
