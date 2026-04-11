// ---------------------------------------------------------------------------
// Mock jose before any imports — HmacActionTokenVerifier imports jose
// ---------------------------------------------------------------------------

jest.mock('jose', () => ({
  SignJWT: jest.fn(),
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
  errors: {},
}));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { ActionTokenGuard } from '../../../src/scoreboard/infrastructure/auth/action-token.guard';
import { ActionTokenClaims } from '../../../src/scoreboard/infrastructure/auth/action-token.types';
import { InvalidActionTokenError } from '../../../src/scoreboard/infrastructure/auth/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CLAIMS: ActionTokenClaims = {
  sub: 'user-1',
  aid: 'action-uuid-1',
  atp: 'level-complete',
  mxd: 100,
  iat: 1_700_000_000,
  exp: 1_700_000_300,
};

function makeVerifier(behaviour: 'resolve' | 'reject', claims = FAKE_CLAIMS) {
  return {
    verify:
      behaviour === 'resolve'
        ? jest.fn().mockResolvedValue(claims)
        : jest.fn().mockRejectedValue(new InvalidActionTokenError('bad token')),
  };
}

function makeRedis(setnxResult: string | null = 'OK') {
  return {
    set: jest.fn().mockResolvedValue(setnxResult),
  };
}

function makeConfig(ttl = 300) {
  return {
    get: jest.fn().mockReturnValue(ttl),
  };
}

function makeCounter() {
  return { inc: jest.fn() };
}

function buildCtx(overrides: {
  userId?: string | null; // null means omit userId from request (simulate missing)
  actionId?: string;
  delta?: number;
  actionToken?: string;
} = {}): { ctx: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {
    // When userId is null, omit from request to simulate JwtGuard not having run
    ...(overrides.userId !== null && overrides.userId !== undefined
      ? { userId: overrides.userId }
      : overrides.userId === null
        ? {}
        : { userId: 'user-1' }),
    headers: {
      'action-token': overrides.actionToken ?? 'fake-action-token',
    },
    body: {
      actionId: overrides.actionId ?? 'action-uuid-1',
      delta: overrides.delta ?? 50,
    },
  };

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { ctx, request };
}

async function catchError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
    throw new Error('Expected to throw');
  } catch (err) {
    return err as Error;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionTokenGuard', () => {
  describe('happy path', () => {
    it('returns true and sets request.actionTokenClaims on success', async () => {
      const verifier = makeVerifier('resolve');
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx, request } = buildCtx();
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request['actionTokenClaims']).toEqual(FAKE_CLAIMS);
      expect(verifier.verify).toHaveBeenCalledWith('fake-action-token', 'user-1', {
        actionId: 'action-uuid-1',
        delta: 50,
      });
      expect(redis.set).toHaveBeenCalledWith(
        'idempotency:action:action-uuid-1',
        '1',
        'EX',
        300,
        'NX',
      );
    });
  });

  describe('missing userId (wiring bug)', () => {
    it('throws a generic Error (not 403) when userId is undefined', async () => {
      const verifier = makeVerifier('resolve');
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx({ userId: null });

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).not.toBeInstanceOf(ForbiddenException);
      expect(err.message).toContain('JwtGuard must run before ActionTokenGuard');
    });
  });

  describe('bad token', () => {
    it('throws ForbiddenException(INVALID_ACTION_TOKEN) when verifier rejects', async () => {
      const verifier = makeVerifier('reject');
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx();
      const err = await catchError(() => guard.canActivate(ctx));

      expect(err).toBeInstanceOf(ForbiddenException);
      const response = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(response['message']).toBe('INVALID_ACTION_TOKEN');
    });
  });

  describe('wrong sub', () => {
    it('throws ForbiddenException when verifier rejects sub mismatch', async () => {
      const verifier = {
        verify: jest.fn().mockRejectedValue(new InvalidActionTokenError('sub mismatch')),
      };
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx({ userId: 'user-2' });
      const err = await catchError(() => guard.canActivate(ctx));

      expect(err).toBeInstanceOf(ForbiddenException);
      const response = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(response['message']).toBe('INVALID_ACTION_TOKEN');
    });
  });

  describe('wrong aid', () => {
    it('throws ForbiddenException when verifier rejects aid mismatch', async () => {
      const verifier = {
        verify: jest.fn().mockRejectedValue(new InvalidActionTokenError('aid mismatch')),
      };
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx({ actionId: 'wrong-aid' });
      const err = await catchError(() => guard.canActivate(ctx));

      expect(err).toBeInstanceOf(ForbiddenException);
    });
  });

  describe('mxd violation', () => {
    it('throws ForbiddenException when verifier rejects delta > mxd', async () => {
      const verifier = {
        verify: jest.fn().mockRejectedValue(new InvalidActionTokenError('mxd too low')),
      };
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx({ delta: 9999 });
      const err = await catchError(() => guard.canActivate(ctx));

      expect(err).toBeInstanceOf(ForbiddenException);
    });
  });

  describe('SETNX win', () => {
    it('proceeds when Redis SETNX returns OK', async () => {
      const verifier = makeVerifier('resolve');
      const redis = makeRedis('OK');
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx();
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
    });
  });

  describe('SETNX loss', () => {
    it('throws ForbiddenException(ACTION_ALREADY_CONSUMED) when SETNX returns null', async () => {
      const verifier = makeVerifier('resolve');
      const redis = makeRedis(null);
      const config = makeConfig();
      const guard = new ActionTokenGuard(verifier as never, redis as never, config as never, makeCounter() as never);

      const { ctx } = buildCtx();
      const err = await catchError(() => guard.canActivate(ctx));

      expect(err).toBeInstanceOf(ForbiddenException);
      const response = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(response['message']).toBe('ACTION_ALREADY_CONSUMED');
    });
  });
});
