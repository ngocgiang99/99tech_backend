// ---------------------------------------------------------------------------
// Mock jose before any imports — HmacActionTokenIssuer imports jose
// ---------------------------------------------------------------------------

jest.mock('jose', () => ({
  SignJWT: jest.fn().mockImplementation(() => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    setSubject: jest.fn().mockReturnThis(),
    setIssuedAt: jest.fn().mockReturnThis(),
    setExpirationTime: jest.fn().mockReturnThis(),
    sign: jest.fn().mockResolvedValue('signed-jwt-token'),
  })),
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
  errors: {},
}));

import { ActionsController } from '../../../../src/scoreboard/interface/http/controllers/actions.controller';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeIssuer(result?: {
  actionId: string;
  actionToken: string;
  expiresAt: Date;
  maxDelta: number;
}) {
  const defaultResult = {
    actionId: VALID_UUID,
    actionToken: 'signed-jwt-token',
    expiresAt: new Date('2025-06-01T12:05:00Z'),
    maxDelta: 100,
  };
  return {
    issue: jest.fn().mockResolvedValue(result ?? defaultResult),
  };
}

function makeRequest(userId = 'user-abc') {
  return { userId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionsController.issueActionToken', () => {
  it('happy path returns actionId, actionToken, expiresAt, maxDelta', async () => {
    const issuer = makeIssuer();
    const controller = new ActionsController(issuer as never);

    const result = await controller.issueActionToken(makeRequest(), { actionType: 'level-complete' });

    expect(result).toEqual({
      actionId: VALID_UUID,
      actionToken: 'signed-jwt-token',
      expiresAt: '2025-06-01T12:05:00.000Z',
      maxDelta: 100,
    });
    expect(issuer.issue).toHaveBeenCalledWith({
      sub: 'user-abc',
      atp: 'level-complete',
      mxd: 100,
    });
  });

  it('uses correct maxDelta for boss-defeat', async () => {
    const issuer = makeIssuer({ actionId: VALID_UUID, actionToken: 'token', expiresAt: new Date(), maxDelta: 500 });
    const controller = new ActionsController(issuer as never);

    await controller.issueActionToken(makeRequest(), { actionType: 'boss-defeat' });

    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({ mxd: 500 }),
    );
  });

  it('uses correct maxDelta for achievement-unlock', async () => {
    const issuer = makeIssuer({ actionId: VALID_UUID, actionToken: 'token', expiresAt: new Date(), maxDelta: 1000 });
    const controller = new ActionsController(issuer as never);

    await controller.issueActionToken(makeRequest(), { actionType: 'achievement-unlock' });

    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({ mxd: 1000 }),
    );
  });

  it('throws ZodError for invalid actionType', async () => {
    const issuer = makeIssuer();
    const controller = new ActionsController(issuer as never);

    await expect(
      controller.issueActionToken(makeRequest(), { actionType: 'unknown-action' }),
    ).rejects.toThrow();
  });
});
