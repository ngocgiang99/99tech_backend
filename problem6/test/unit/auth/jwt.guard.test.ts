// ---------------------------------------------------------------------------
// Mock jose before any imports — jose is ESM-only and requires mocking in
// Jest's CommonJS environment.
//
// Strategy: the mock jwtVerify validates the token structurally:
//   - extracts the header's alg field
//   - if alg !== 'HS256', throws JWSInvalidAlgorithm
//   - decodes the payload and checks exp
//   - compares the "signature" (last segment) to a deterministic value
//     derived from the secret to simulate signature checking
// This exercises the guard's real code paths without needing real HMAC.
// ---------------------------------------------------------------------------

const mockJwtVerify = jest.fn();

jest.mock('jose', () => {
  // A minimal generateKeyPair mock that produces key-like objects usable for
  // building RS256 token headers in tests (the actual key bytes don't matter
  // because the mock jwtVerify inspects the alg header, not the key).
  const generateKeyPair = jest.fn((alg: string) =>
    Promise.resolve({
      privateKey: { type: 'private', alg } as unknown,
      publicKey: { type: 'public', alg } as unknown,
    }),
  );

  // SignJWT mock: builds a structurally valid JWT with real base64url encoding.
  // The "signature" encodes the alg + a fake-secret marker so the mock jwtVerify
  // can detect wrong-secret scenarios.
  class SignJWT {
    private _payload: Record<string, unknown>;
    private _header: Record<string, unknown> = {};

    constructor(payload: Record<string, unknown>) {
      this._payload = payload;
    }

    setProtectedHeader(header: Record<string, unknown>) {
      this._header = header;
      return this;
    }

    setExpirationTime(exp: string | number) {
      if (typeof exp === 'string') {
        // Parse relative time expressions like '5m', '-1s', '1h'
        const m = exp.match(/^(-?\d+)([smhd])$/);
        if (m) {
          const n = parseInt(m[1], 10);
          const unit = m[2];
          const secs = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
          this._payload = {
            ...this._payload,
            exp: Math.floor(Date.now() / 1000) + n * secs,
          };
        }
      } else {
        this._payload = { ...this._payload, exp };
      }
      return this;
    }

    setIssuedAt() {
      this._payload = { ...this._payload, iat: Math.floor(Date.now() / 1000) };
      return this;
    }

    sign(key: unknown): Promise<string> {
      const headerB64 = Buffer.from(JSON.stringify(this._header)).toString(
        'base64url',
      );
      const payloadB64 = Buffer.from(JSON.stringify(this._payload)).toString(
        'base64url',
      );
      // Encode the key reference into the signature so the verifier can detect
      // wrong-secret scenarios. If the key is a Uint8Array (HS256 path), encode
      // its first 8 bytes; for asymmetric keys (RS256), encode the key.alg.
      let keyMark = 'nokey';
      if (key instanceof Uint8Array) {
        keyMark = Buffer.from(key.slice(0, 8)).toString('base64url');
      } else if (
        key &&
        typeof (key as Record<string, unknown>)['alg'] === 'string'
      ) {
        keyMark = `asym:${String((key as Record<string, unknown>)['alg'])}`;
      }
      const sig = Buffer.from(`sig:${headerB64}:${keyMark}`).toString(
        'base64url',
      );
      return Promise.resolve(`${headerB64}.${payloadB64}.${sig}`);
    }
  }

  return {
    SignJWT,
    generateKeyPair,
    jwtVerify: mockJwtVerify,
    errors: {
      JOSEError: class JOSEError extends Error {
        constructor(msg?: string) {
          super(msg);
          this.name = 'JOSEError';
        }
      },
      JWSInvalidAlgorithm: class JWSInvalidAlgorithm extends Error {
        constructor(msg?: string) {
          super(msg);
          this.name = 'JWSInvalidAlgorithm';
        }
      },
      JWTExpired: class JWTExpired extends Error {
        constructor(msg?: string) {
          super(msg);
          this.name = 'JWTExpired';
        }
      },
      JWSSignatureVerificationFailed: class JWSSignatureVerificationFailed extends Error {
        constructor(msg?: string) {
          super(msg);
          this.name = 'JWSSignatureVerificationFailed';
        }
      },
    },
  };
});

import * as jose from 'jose';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { JwtGuard } from '../../../src/scoreboard/infrastructure/auth/jwt.guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'a-32-byte-internal-jwt-secret-ok!';
const TEST_SECRET_BYTES = new TextEncoder().encode(TEST_SECRET);

function makeConfigService(secret = TEST_SECRET) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'INTERNAL_JWT_SECRET') return secret;
      return undefined;
    }),
  };
}

function makeGuard(secret = TEST_SECRET): JwtGuard {
  return new JwtGuard(makeConfigService(secret) as never);
}

async function buildToken(
  payload: Record<string, unknown>,
  key: Uint8Array | Record<string, unknown>,
  alg = 'HS256',
  exp = '5m',
): Promise<string> {
  const builder = new jose.SignJWT(payload)
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime(exp);
  return (builder as unknown as { sign(k: unknown): Promise<string> }).sign(
    key,
  );
}

async function catchError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
    throw new Error('Expected to throw but did not');
  } catch (err) {
    return err as Error;
  }
}

// ---------------------------------------------------------------------------
// Configure mockJwtVerify to behave realistically for each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  // Default behaviour: parse the token structurally and validate
  mockJwtVerify.mockImplementation(
    (token: string, key: Uint8Array, options: { algorithms?: string[] }) => {
      const parts = token.split('.');
      if (parts.length < 3) return Promise.reject(new Error('Invalid JWT'));

      let headerRaw: Record<string, unknown>;
      let payloadRaw: Record<string, unknown>;
      try {
        headerRaw = JSON.parse(
          Buffer.from(parts[0], 'base64url').toString('utf8'),
        ) as Record<string, unknown>;
        payloadRaw = JSON.parse(
          Buffer.from(parts[1], 'base64url').toString('utf8'),
        ) as Record<string, unknown>;
      } catch {
        return Promise.reject(new Error('Invalid JWT encoding'));
      }

      // Algorithm check
      if (
        options?.algorithms &&
        !options.algorithms.includes(headerRaw['alg'] as string)
      ) {
        return Promise.reject(
          new Error('"alg" (Algorithm) Header Parameter value not allowed'),
        );
      }

      // Signature check — compare expected key mark
      const expectedKeyMark =
        key instanceof Uint8Array
          ? Buffer.from(key.slice(0, 8)).toString('base64url')
          : 'nokey';
      const expectedSig = Buffer.from(
        `sig:${parts[0]}:${expectedKeyMark}`,
      ).toString('base64url');
      if (parts[2] !== expectedSig) {
        return Promise.reject(new Error('JWSSignatureVerificationFailed'));
      }

      // Expiry check
      if (
        typeof payloadRaw['exp'] === 'number' &&
        payloadRaw['exp'] < Math.floor(Date.now() / 1000)
      ) {
        return Promise.reject(
          new Error('JWTExpired: "exp" claim timestamp check failed'),
        );
      }

      return Promise.resolve({
        payload: payloadRaw,
        protectedHeader: headerRaw,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JwtGuard', () => {
  describe('4.4 — happy path', () => {
    it('returns true and sets request.userId on a valid HS256 token', async () => {
      const guard = makeGuard();
      const token = await buildToken(
        { sub: 'user-abc' },
        TEST_SECRET_BYTES,
        'HS256',
        '5m',
      );
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request['userId']).toBe('user-abc');
    });
  });

  describe('4.5 — missing Authorization header', () => {
    it('throws UnauthorizedException when no header is present', async () => {
      const guard = makeGuard();
      const request: Record<string, unknown> = { headers: {} };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when prefix is not Bearer', async () => {
      const guard = makeGuard();
      const request: Record<string, unknown> = {
        headers: { authorization: 'Token some-token' },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when header is malformed (not decodable JSON)', async () => {
      const guard = makeGuard();
      // A token whose header segment is not valid base64url JSON
      const token = 'notvalidbase64!.payload.sig';
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('4.6 — wrong secret', () => {
    it('throws UnauthorizedException when token is signed with a different secret', async () => {
      const guard = makeGuard(TEST_SECRET);
      const wrongSecretBytes = new TextEncoder().encode(
        'a-different-32-byte-secret-here!!',
      );
      const token = await buildToken(
        { sub: 'user-abc' },
        wrongSecretBytes,
        'HS256',
        '5m',
      );
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('4.7 — expired token', () => {
    it('throws UnauthorizedException when token exp is in the past', async () => {
      const guard = makeGuard();
      const token = await buildToken(
        { sub: 'user-abc' },
        TEST_SECRET_BYTES,
        'HS256',
        '-1s',
      );
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('4.8 — alg=none rejection (pre-verify, before jwtVerify)', () => {
    it('throws UnauthorizedException before calling jwtVerify when alg is none', async () => {
      const guard = makeGuard();
      // Hand-craft an alg=none token (SignJWT won't produce it)
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'attacker', exp: 9999999999 }),
      ).toString('base64url');
      const token = `${header}.${payload}.`;
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
      // Must NOT call jwtVerify — rejection happens before signature verification
      expect(mockJwtVerify).not.toHaveBeenCalled();
    });
  });

  describe('4.9 — alg=RS256 rejection (algorithm allowlist)', () => {
    it('throws UnauthorizedException when token header has alg=RS256', async () => {
      const guard = makeGuard();
      // Use generateKeyPair mock to produce a key-like object, sign an RS256 token
      const { privateKey } = await jose.generateKeyPair('RS256');
      const token = await buildToken(
        { sub: 'attacker' },
        privateKey as never,
        'RS256',
        '5m',
      );
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('4.10 — tampered signature', () => {
    it('throws UnauthorizedException when signature is mutated', async () => {
      const guard = makeGuard();
      const token = await buildToken(
        { sub: 'user-abc' },
        TEST_SECRET_BYTES,
        'HS256',
        '5m',
      );
      const parts = token.split('.');
      const sig = parts[2];
      const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
      const tamperedToken = `${parts[0]}.${parts[1]}.${tampered}`;
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${tamperedToken}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('4.11 — iss/aud claims ignored', () => {
    it('returns true even when iss and aud have arbitrary values', async () => {
      const guard = makeGuard();
      const token = await buildToken(
        { sub: 'user-abc', iss: 'random-issuer', aud: 'random-audience' },
        TEST_SECRET_BYTES,
        'HS256',
        '5m',
      );
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(request['userId']).toBe('user-abc');
    });
  });

  describe('error message does not leak details', () => {
    it('always returns generic Unauthorized message regardless of failure reason', async () => {
      const guard = makeGuard();
      const request: Record<string, unknown> = { headers: {} };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      const err = await catchError(() => guard.canActivate(ctx));
      expect(err).toBeInstanceOf(UnauthorizedException);
      const response = (err as UnauthorizedException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response['message']).toBe('Unauthorized');
    });
  });
});
