// ---------------------------------------------------------------------------
// Mock shared/metrics and jose before any imports
// ---------------------------------------------------------------------------

jest.mock('../../../../src/shared/metrics', () => ({
  METRIC_SCORE_INCREMENT_TOTAL: 'metric.scoreboard_score_increment_total',
  scoreIncrementTotal: { inc: jest.fn() },
  METRIC_ACTION_TOKEN_VERIFY_TOTAL: 'metric.scoreboard_action_token_verify_total',
  METRIC_RATE_LIMIT_HITS_TOTAL: 'metric.scoreboard_rate_limit_hits_total',
}));

jest.mock('jose', () => ({
  SignJWT: jest.fn(),
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
  errors: {},
}));

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: jest.fn((_name: string, fn: (span: unknown) => unknown) =>
        fn({ setStatus: jest.fn(), end: jest.fn() }),
      ),
    }),
  },
  SpanStatusCode: { ERROR: 2, OK: 1 },
}));

import { ScoreboardController } from '../../../../src/scoreboard/interface/http/controllers/scoreboard.controller';
import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import type { IncrementScoreResult } from '../../../../src/scoreboard/application/commands';
import type { AuthenticatedRequest } from '../../../../src/scoreboard/interface/http/authenticated-request';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_ACTION_UUID = '550e8400-e29b-41d4-a716-446655440001';

function makeHandler(result?: IncrementScoreResult) {
  return {
    execute: jest.fn().mockResolvedValue(
      result ?? {
        kind: 'committed',
        userId: VALID_UUID,
        newScore: 100,
        rank: null,
        topChanged: null,
      },
    ),
  };
}

function makeRequest(userId = VALID_UUID): AuthenticatedRequest {
  return { userId } as unknown as AuthenticatedRequest;
}

function makeBody(overrides: Partial<{ actionId: string; delta: number }> = {}) {
  return { actionId: VALID_ACTION_UUID, delta: 10, ...overrides };
}

describe('ScoreboardController.incrementScore', () => {
  it('happy path returns handler result with kind stripped', async () => {
    const handler = makeHandler({
      kind: 'committed',
      userId: VALID_UUID,
      newScore: 100,
      rank: null,
      topChanged: null,
    });
    const controller = new ScoreboardController(handler as never);

    const result = await controller.incrementScore(makeRequest(), makeBody());

    expect(result).toEqual({
      userId: VALID_UUID,
      newScore: 100,
      rank: null,
      topChanged: null,
    });
    expect((result as Record<string, unknown>).kind).toBeUndefined();
    expect(handler.execute).toHaveBeenCalledTimes(1);
  });

  it('idempotent-replay result has kind stripped in response', async () => {
    const handler = makeHandler({
      kind: 'idempotent-replay',
      userId: VALID_UUID,
      newScore: 200,
      rank: null,
      topChanged: null,
    });
    const controller = new ScoreboardController(handler as never);

    const result = await controller.incrementScore(makeRequest(), makeBody());

    expect(result).toEqual({
      userId: VALID_UUID,
      newScore: 200,
      rank: null,
      topChanged: null,
    });
    expect((result as Record<string, unknown>).kind).toBeUndefined();
  });

  it('throws ZodError (400) for invalid body — non-UUID actionId', async () => {
    const handler = makeHandler();
    const controller = new ScoreboardController(handler as never);

    await expect(
      controller.incrementScore(makeRequest(), { actionId: 'not-a-uuid', delta: 10 }),
    ).rejects.toThrow();
  });

  it('throws ZodError (400) for delta = 0', async () => {
    const handler = makeHandler();
    const controller = new ScoreboardController(handler as never);

    await expect(
      controller.incrementScore(makeRequest(), { actionId: VALID_ACTION_UUID, delta: 0 }),
    ).rejects.toThrow();
  });

  it('propagates non-idempotency errors from handler', async () => {
    const handler = {
      execute: jest.fn().mockRejectedValue(new InvalidArgumentError('bad delta')),
    };
    const controller = new ScoreboardController(handler as never);

    await expect(
      controller.incrementScore(makeRequest(), makeBody()),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
