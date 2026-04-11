// ---------------------------------------------------------------------------
// Mock jose before any imports — keeps the module in CommonJS-compatible form
// ---------------------------------------------------------------------------

const mockSignResult = 'mock.action.token';
const mockSign = jest.fn().mockResolvedValue(mockSignResult);
const mockSetExpirationTime = jest.fn().mockReturnThis();
const mockSetIssuedAt = jest.fn().mockReturnThis();
const mockSetSubject = jest.fn().mockReturnThis();
const mockSetProtectedHeader = jest.fn().mockReturnThis();
const mockSignJWT = jest.fn().mockImplementation(() => ({
  setProtectedHeader: mockSetProtectedHeader,
  setSubject: mockSetSubject,
  setIssuedAt: mockSetIssuedAt,
  setExpirationTime: mockSetExpirationTime,
  sign: mockSign,
}));

jest.mock('jose', () => ({
  SignJWT: mockSignJWT,
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
  errors: {},
}));

import { HmacActionTokenIssuer } from '../../../src/scoreboard/infrastructure/auth/hmac-action-token.issuer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'a-32-byte-secret-for-testing-purposes!!';
const TTL = 300;

function makeConfig(ttl = TTL) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'ACTION_TOKEN_SECRET') return SECRET;
      if (key === 'ACTION_TOKEN_TTL_SECONDS') return ttl;
      return undefined;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HmacActionTokenIssuer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-setup mock chain (clearAllMocks removes mockReturnThis)
    mockSetProtectedHeader.mockReturnThis();
    mockSetSubject.mockReturnThis();
    mockSetIssuedAt.mockReturnThis();
    mockSetExpirationTime.mockReturnThis();
    mockSign.mockResolvedValue(mockSignResult);
  });

  describe('happy path', () => {
    it('issues a token envelope with correct shape', async () => {
      const config = makeConfig();
      const issuer = new HmacActionTokenIssuer(config as never);

      const result = await issuer.issue({ sub: 'user-1', atp: 'level-complete', mxd: 100 });

      expect(result.actionId).toBeDefined();
      expect(typeof result.actionId).toBe('string');
      expect(result.actionToken).toBe(mockSignResult);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.maxDelta).toBe(100);
    });

    it('passes correct claims to SignJWT', async () => {
      const config = makeConfig();
      const issuer = new HmacActionTokenIssuer(config as never);

      const result = await issuer.issue({ sub: 'user-1', atp: 'level-complete', mxd: 100 });

      expect(mockSignJWT).toHaveBeenCalledWith({
        aid: result.actionId,
        atp: 'level-complete',
        mxd: 100,
      });
      expect(mockSetProtectedHeader).toHaveBeenCalledWith({ alg: 'HS256' });
      expect(mockSetSubject).toHaveBeenCalledWith('user-1');
    });

    it('generates a unique actionId on each call', async () => {
      const config = makeConfig();
      const issuer = new HmacActionTokenIssuer(config as never);

      const r1 = await issuer.issue({ sub: 'u', atp: 'level-complete', mxd: 10 });
      const r2 = await issuer.issue({ sub: 'u', atp: 'level-complete', mxd: 10 });

      expect(r1.actionId).not.toBe(r2.actionId);
    });
  });

  describe('TTL math', () => {
    it('sets expiresAt to iat + TTL_SECONDS', async () => {
      const fixedNow = 1_700_000_000_000; // ms
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(fixedNow);

      try {
        const config = makeConfig(300);
        const issuer = new HmacActionTokenIssuer(config as never);

        const result = await issuer.issue({ sub: 'u', atp: 'level-complete', mxd: 50 });

        const expectedExp = Math.floor(fixedNow / 1000) + 300;
        expect(result.expiresAt.getTime()).toBe(expectedExp * 1000);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('calls setExpirationTime with now + TTL', async () => {
      const fixedNow = 1_700_000_000_000;
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(fixedNow);

      try {
        const config = makeConfig(600);
        const issuer = new HmacActionTokenIssuer(config as never);

        await issuer.issue({ sub: 'u', atp: 'boss-defeat', mxd: 500 });

        const expectedNow = Math.floor(fixedNow / 1000);
        expect(mockSetIssuedAt).toHaveBeenCalledWith(expectedNow);
        expect(mockSetExpirationTime).toHaveBeenCalledWith(expectedNow + 600);
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});
