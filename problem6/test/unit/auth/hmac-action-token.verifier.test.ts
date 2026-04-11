// ---------------------------------------------------------------------------
// Mock jose before any imports
// ---------------------------------------------------------------------------

const mockJwtVerify = jest.fn();

class MockJWSSignatureVerificationFailed extends Error {
  constructor() {
    super('JWSSignatureVerificationFailed');
    this.name = 'JWSSignatureVerificationFailed';
  }
}

jest.mock('jose', () => ({
  SignJWT: jest.fn(),
  jwtVerify: mockJwtVerify,
  createRemoteJWKSet: jest.fn(),
  errors: {
    JWSSignatureVerificationFailed: MockJWSSignatureVerificationFailed,
  },
}));

import { InvalidActionTokenError } from '../../../src/scoreboard/infrastructure/auth/errors';
import { HmacActionTokenVerifier } from '../../../src/scoreboard/infrastructure/auth/hmac-action-token.verifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'a-32-byte-secret-for-testing-purposes!!';
const PREV_SECRET = 'a-32-byte-prev-secret-for-testing!!!!!!';

function makeConfig(withPrev = false) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'ACTION_TOKEN_SECRET') return SECRET;
      if (key === 'ACTION_TOKEN_SECRET_PREV') return withPrev ? PREV_SECRET : undefined;
      return undefined;
    }),
  };
}

function makePayload(overrides: Partial<{
  sub: string;
  aid: string;
  atp: string;
  mxd: number;
  iat: number;
  exp: number;
}> = {}) {
  return {
    sub: 'user-1',
    aid: 'action-uuid-1',
    atp: 'level-complete',
    mxd: 100,
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    ...overrides,
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

describe('HmacActionTokenVerifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns ActionTokenClaims when all checks pass', async () => {
      mockJwtVerify.mockResolvedValue({ payload: makePayload() });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const claims = await verifier.verify('fake-token', 'user-1', { actionId: 'action-uuid-1', delta: 50 });

      expect(claims.sub).toBe('user-1');
      expect(claims.aid).toBe('action-uuid-1');
      expect(claims.atp).toBe('level-complete');
      expect(claims.mxd).toBe(100);
      expect(claims.iat).toBe(1_700_000_000);
      expect(claims.exp).toBe(1_700_000_300);
    });

    it('allows delta equal to mxd (boundary case)', async () => {
      mockJwtVerify.mockResolvedValue({ payload: makePayload({ mxd: 10 }) });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const claims = await verifier.verify('fake-token', 'user-1', { actionId: 'action-uuid-1', delta: 10 });
      expect(claims.mxd).toBe(10);
    });

    it('calls jwtVerify with HS256 algorithm constraint', async () => {
      mockJwtVerify.mockResolvedValue({ payload: makePayload() });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      await verifier.verify('my-token', 'user-1', { actionId: 'action-uuid-1', delta: 1 });

      expect(mockJwtVerify).toHaveBeenCalledWith(
        'my-token',
        expect.any(Uint8Array),
        { algorithms: ['HS256'] },
      );
    });
  });

  describe('expired token', () => {
    it('throws InvalidActionTokenError when jwtVerify rejects (expired)', async () => {
      mockJwtVerify.mockRejectedValue(new Error('JWTExpired: ...'));

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('expired-token', 'user-1', { actionId: 'action-uuid-1', delta: 1 }),
      );
      expect(err).toBeInstanceOf(InvalidActionTokenError);
    });
  });

  describe('wrong sub', () => {
    it('throws InvalidActionTokenError when payload.sub does not match expectedSub', async () => {
      mockJwtVerify.mockResolvedValue({ payload: makePayload({ sub: 'user-1' }) });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('token', 'user-2', { actionId: 'action-uuid-1', delta: 1 }),
      );
      expect(err).toBeInstanceOf(InvalidActionTokenError);
    });
  });

  describe('wrong aid', () => {
    it('throws InvalidActionTokenError when payload.aid does not match body.actionId', async () => {
      mockJwtVerify.mockResolvedValue({ payload: makePayload({ aid: 'correct-aid' }) });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('token', 'user-1', { actionId: 'wrong-aid', delta: 1 }),
      );
      expect(err).toBeInstanceOf(InvalidActionTokenError);
    });
  });

  describe('mxd too low', () => {
    it('throws InvalidActionTokenError when delta exceeds mxd', async () => {
      mockJwtVerify.mockResolvedValue({ payload: makePayload({ mxd: 10 }) });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('token', 'user-1', { actionId: 'action-uuid-1', delta: 100 }),
      );
      expect(err).toBeInstanceOf(InvalidActionTokenError);
    });

    it('throws InvalidActionTokenError when mxd is not a number', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: makePayload({ mxd: undefined as unknown as number }),
      });

      const config = makeConfig();
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('token', 'user-1', { actionId: 'action-uuid-1', delta: 1 }),
      );
      expect(err).toBeInstanceOf(InvalidActionTokenError);
    });
  });

  describe('bad signature — no prev key', () => {
    it('throws InvalidActionTokenError when primary sig fails and no prev key is set', async () => {
      mockJwtVerify.mockRejectedValue(new MockJWSSignatureVerificationFailed());

      const config = makeConfig(false);
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('tampered-token', 'user-1', { actionId: 'action-uuid-1', delta: 1 }),
      );
      expect(err).toBeInstanceOf(InvalidActionTokenError);
    });
  });

  describe('dual-secret fallback', () => {
    it('succeeds when token is signed by prev key and both secrets are set', async () => {
      // First call (primary) rejects with signature failure; second call (prev) succeeds
      mockJwtVerify
        .mockRejectedValueOnce(new MockJWSSignatureVerificationFailed())
        .mockResolvedValueOnce({ payload: makePayload() });

      const config = makeConfig(true);
      const verifier = new HmacActionTokenVerifier(config as never);

      const claims = await verifier.verify('prev-signed-token', 'user-1', {
        actionId: 'action-uuid-1',
        delta: 50,
      });

      expect(claims.sub).toBe('user-1');
      expect(claims.aid).toBe('action-uuid-1');
      expect(mockJwtVerify).toHaveBeenCalledTimes(2);
    });

    it('throws InvalidActionTokenError when both primary and prev keys reject', async () => {
      // Both calls reject — token signed by a third unknown key
      mockJwtVerify
        .mockRejectedValueOnce(new MockJWSSignatureVerificationFailed())
        .mockRejectedValueOnce(new MockJWSSignatureVerificationFailed());

      const config = makeConfig(true);
      const verifier = new HmacActionTokenVerifier(config as never);

      const err = await catchError(() =>
        verifier.verify('unknown-signed-token', 'user-1', {
          actionId: 'action-uuid-1',
          delta: 1,
        }),
      );

      expect(err).toBeInstanceOf(InvalidActionTokenError);
      expect(mockJwtVerify).toHaveBeenCalledTimes(2);
    });
  });
});
