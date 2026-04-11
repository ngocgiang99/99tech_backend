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

function makeBucketThrowing(error: Error) {
  return { consume: jest.fn().mockRejectedValue(error) };
}

function makeCounter() {
  return { inc: jest.fn() };
}

// ---------------------------------------------------------------------------
// Helper: fresh require to reset module-level globalCount
// ---------------------------------------------------------------------------
function freshGuard() {
  jest.resetModules();

  /* eslint-disable @typescript-eslint/no-require-imports */
  const mod =
    // prettier-ignore
    require('../../../src/scoreboard/infrastructure/rate-limit/rate-limit.guard') as typeof import('../../../src/scoreboard/infrastructure/rate-limit/rate-limit.guard');
  /* eslint-enable @typescript-eslint/no-require-imports */
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
      const Guard = freshGuard();
      const bucket = makeBucket({ allowed: true });
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      const result = await guard.canActivate(buildCtx('user-1'));

      expect(result).toBe(true);
      expect(bucket.consume).toHaveBeenCalledWith('user-1', 20, 10);
      expect(hitsCounter.inc).toHaveBeenCalledWith({ outcome: 'allowed' });
      expect(failedClosedCounter.inc).not.toHaveBeenCalled();
    });
  });

  describe('reject path (429)', () => {
    it('throws 429 and sets Retry-After header when bucket rejects', async () => {
      const Guard = freshGuard();
      const bucket = makeBucket({ allowed: false, retryAfterMs: 500 });
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      const ctx = buildCtx('user-2');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const response = ctx.switchToHttp().getResponse();

      const err = await catchError(guard.canActivate(ctx));
      expect(err).toHaveProperty('getStatus');

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ex = err as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getStatus()).toBe(429);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getResponse().code).toBe('RATE_LIMITED');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.header).toHaveBeenCalledWith('Retry-After', '1');
      expect(hitsCounter.inc).toHaveBeenCalledWith({ outcome: 'rejected' });
    });

    it('defaults Retry-After to 1 second when retryAfterMs is undefined', async () => {
      const Guard = freshGuard();
      const bucket = makeBucket({ allowed: false });
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      const ctx = buildCtx('user-3');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const response = ctx.switchToHttp().getResponse();

      const err = await catchError(guard.canActivate(ctx));

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ex = err as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getStatus()).toBe(429);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.header).toHaveBeenCalledWith('Retry-After', '1');
    });
  });

  describe('wiring guard (missing userId)', () => {
    it('throws an error when userId is undefined (JwtGuard not wired)', async () => {
      const Guard = freshGuard();
      const bucket = makeBucket({ allowed: true });
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      const err = await catchError(guard.canActivate(buildCtx(undefined)));
      expect(err.message).toContain('JwtGuard must run first');
    });
  });

  describe('global circuit breaker (503)', () => {
    it('throws 503 after more than 5000 calls within the same second', async () => {
      const Guard = freshGuard();
      // Use a bucket that always admits, so the guard reaches the count check
      const bucket = makeBucket({ allowed: true });
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      const ctx = buildCtx('user-circuit');

      // Fire 5000 successful requests
      for (let i = 0; i < 5000; i++) {
        await guard.canActivate(ctx);
      }

      // The 5001st should trip the breaker
      const err = await catchError(guard.canActivate(ctx));

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ex = err as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getStatus()).toBe(503);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getResponse().code).toBe('TEMPORARILY_UNAVAILABLE');
      expect(hitsCounter.inc).toHaveBeenCalledWith({ outcome: 'circuit_open' });
    });
  });

  describe('fail-CLOSED (Redis error → 503)', () => {
    it('throws 503 TEMPORARILY_UNAVAILABLE when bucket.consume throws', async () => {
      const Guard = freshGuard();
      const redisError = new Error('Redis connection refused');
      const bucket = makeBucketThrowing(redisError);
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      const err = await catchError(
        guard.canActivate(buildCtx('user-redis-down')),
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const ex = err as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getStatus()).toBe(503);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getResponse().code).toBe('TEMPORARILY_UNAVAILABLE');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      expect(ex.getResponse().message).toBe(
        'Rate limit service temporarily unavailable',
      );
    });

    it('increments scoreboard_rate_limit_failed_closed_total counter on Redis error', async () => {
      const Guard = freshGuard();
      const bucket = makeBucketThrowing(new Error('ECONNRESET'));
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      await catchError(guard.canActivate(buildCtx('user-redis-down-2')));

      expect(failedClosedCounter.inc).toHaveBeenCalledTimes(1);
      // hits counter should NOT be incremented (the request never got through)
      expect(hitsCounter.inc).not.toHaveBeenCalled();
    });

    it('does not silently allow the request on Redis error (throws, not resolves)', async () => {
      const Guard = freshGuard();
      const bucket = makeBucketThrowing(new Error('timeout'));
      const config = makeConfig(10);
      const hitsCounter = makeCounter();
      const failedClosedCounter = makeCounter();
      const guard = new Guard(
        bucket as never,
        config as never,
        hitsCounter as never,
        failedClosedCounter as never,
      );

      await expect(
        guard.canActivate(buildCtx('user-redis-down-3')),
      ).rejects.toThrow();
    });
  });
});
