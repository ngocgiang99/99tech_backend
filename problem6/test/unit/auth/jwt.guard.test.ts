// ---------------------------------------------------------------------------
// Mock jose before any imports — JwksCache imports jose
// ---------------------------------------------------------------------------

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  errors: { JOSEError: class JOSEError extends Error {} },
}));

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { InvalidJwtError } from '../../../src/scoreboard/infrastructure/auth/errors';
import { JwtGuard } from '../../../src/scoreboard/infrastructure/auth/jwt.guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a base64url-encoded JWT header segment */
function makeHeaderSegment(alg: string): string {
  const header = JSON.stringify({ alg, typ: 'JWT' });
  return Buffer.from(header).toString('base64url');
}

/** Build a fake JWT string: header.payload.signature */
function makeToken(alg: string, payloadObj: Record<string, unknown> = {}): string {
  const header = makeHeaderSegment(alg);
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function makeJwksCache(behaviour: 'resolve' | 'reject', sub = 'user-123') {
  return {
    verify:
      behaviour === 'resolve'
        ? jest.fn().mockResolvedValue({ sub })
        : jest.fn().mockRejectedValue(new InvalidJwtError('verification failed')),
  };
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

describe('JwtGuard', () => {
  describe('happy path', () => {
    it('returns true and sets request.userId on a valid token', async () => {
      const jwks = makeJwksCache('resolve', 'user-abc');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256', { sub: 'user-abc' });
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request['userId']).toBe('user-abc');
      expect(jwks.verify).toHaveBeenCalledWith(token);
    });
  });

  describe('missing Authorization header', () => {
    it('throws UnauthorizedException when no header is present', async () => {
      const jwks = makeJwksCache('resolve');
      const guard = new JwtGuard(jwks as never);
      const request: Record<string, unknown> = { headers: {} };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(jwks.verify).not.toHaveBeenCalled();
    });
  });

  describe('wrong Bearer prefix', () => {
    it('throws UnauthorizedException when prefix is not Bearer', async () => {
      const jwks = makeJwksCache('resolve');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256');
      const request: Record<string, unknown> = { headers: { authorization: `Token ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(jwks.verify).not.toHaveBeenCalled();
    });
  });

  describe('alg=none rejection (pre-verify)', () => {
    it('throws UnauthorizedException before calling jwks.verify when alg is none', async () => {
      const jwks = makeJwksCache('resolve');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('none', { sub: 'attacker' });
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
      // Must NOT call verify — the rejection happens before signature verification
      expect(jwks.verify).not.toHaveBeenCalled();
    });
  });

  describe('expired token', () => {
    it('throws UnauthorizedException when JwksCache rejects with expired error', async () => {
      const jwks = makeJwksCache('reject');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256');
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('wrong audience', () => {
    it('throws UnauthorizedException when JwksCache rejects due to wrong aud', async () => {
      const jwks = makeJwksCache('reject');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256');
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('wrong issuer', () => {
    it('throws UnauthorizedException when JwksCache rejects due to wrong iss', async () => {
      const jwks = makeJwksCache('reject');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256');
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('tampered signature', () => {
    it('throws UnauthorizedException when JwksCache rejects due to bad signature', async () => {
      const jwks = makeJwksCache('reject');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256');
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('error message does not leak details', () => {
    it('always returns generic Unauthorized message regardless of failure reason', async () => {
      const jwks = makeJwksCache('reject');
      const guard = new JwtGuard(jwks as never);
      const token = makeToken('RS256');
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
      const response = (err as UnauthorizedException).getResponse() as Record<string, unknown>;
      expect(response['message']).toBe('Unauthorized');
    });
  });
});
