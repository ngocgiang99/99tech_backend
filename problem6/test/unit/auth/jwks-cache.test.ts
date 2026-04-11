// ---------------------------------------------------------------------------
// Mock jose before any imports — JwksCache imports jose
// ---------------------------------------------------------------------------

const mockCreateRemoteJWKSet = jest.fn();
const mockJwtVerify = jest.fn();

jest.mock('jose', () => ({
  createRemoteJWKSet: mockCreateRemoteJWKSet,
  jwtVerify: mockJwtVerify,
  errors: {
    JOSEError: class JOSEError extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'JOSEError';
      }
    },
  },
}));

import { InvalidJwtError } from '../../../src/scoreboard/infrastructure/auth/errors';
import { JwksCache } from '../../../src/scoreboard/infrastructure/auth/jwks-cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    JWKS_URL: 'https://example.com/.well-known/jwks.json',
    JWT_ISSUER: 'https://example.com',
    JWT_AUDIENCE: 'scoreboard-api',
  };
  return {
    get: jest.fn((key: string) => overrides[key] ?? defaults[key]),
  };
}

function makeFakeJwksGetter() {
  return jest.fn(); // simulates the function returned by createRemoteJWKSet
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

describe('JwksCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns payload when jwtVerify resolves', async () => {
      const fakeGetter = makeFakeJwksGetter();
      mockCreateRemoteJWKSet.mockReturnValue(fakeGetter);

      const expectedPayload = { sub: 'user-123', iat: 1700000000, exp: 1700000300 };
      mockJwtVerify.mockResolvedValue({ payload: expectedPayload });

      const config = makeConfig();
      const cache = new JwksCache(config as never);

      const result = await cache.verify('fake-token');

      expect(result).toEqual(expectedPayload);
      expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
      expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
        new URL('https://example.com/.well-known/jwks.json'),
        {},
      );
      expect(mockJwtVerify).toHaveBeenCalledWith('fake-token', fakeGetter, {
        issuer: 'https://example.com',
        audience: 'scoreboard-api',
        algorithms: ['RS256', 'ES256'],
      });
    });

    it('lazily initialises JWKS getter only once across multiple calls', async () => {
      const fakeGetter = makeFakeJwksGetter();
      mockCreateRemoteJWKSet.mockReturnValue(fakeGetter);
      mockJwtVerify.mockResolvedValue({ payload: { sub: 'u1' } });

      const config = makeConfig();
      const cache = new JwksCache(config as never);

      await cache.verify('token-1');
      await cache.verify('token-2');

      expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
      expect(mockJwtVerify).toHaveBeenCalledTimes(2);
    });
  });

  describe('JOSE error', () => {
    it('wraps JOSEError in InvalidJwtError', async () => {
      const fakeGetter = makeFakeJwksGetter();
      mockCreateRemoteJWKSet.mockReturnValue(fakeGetter);

      const { errors } = await import('jose');
      const joseErr = new errors.JOSEError('token expired');
      mockJwtVerify.mockRejectedValue(joseErr);

      const config = makeConfig();
      const cache = new JwksCache(config as never);

      const err = await catchError(() => cache.verify('expired-token'));
      expect(err).toBeInstanceOf(InvalidJwtError);
      expect(err.message).toBe('token expired');
    });
  });

  describe('non-JOSE error', () => {
    it('re-throws non-JOSEError as-is', async () => {
      const fakeGetter = makeFakeJwksGetter();
      mockCreateRemoteJWKSet.mockReturnValue(fakeGetter);

      const networkErr = new Error('Network timeout');
      mockJwtVerify.mockRejectedValue(networkErr);

      const config = makeConfig();
      const cache = new JwksCache(config as never);

      const err = await catchError(() => cache.verify('some-token'));
      expect(err).toBe(networkErr);
      expect(err).not.toBeInstanceOf(InvalidJwtError);
    });
  });
});
