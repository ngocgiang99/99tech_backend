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

import { InternalServerErrorException } from '@nestjs/common';

import { ScoreboardController } from '../../../../src/scoreboard/interface/http/controllers/scoreboard.controller';
import { IdempotencyViolationError } from '../../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import type { ScoreEventRecord } from '../../../../src/scoreboard/domain/ports/user-score.repository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_ACTION_UUID = '550e8400-e29b-41d4-a716-446655440001';

function makeHandler(result?: { userId: string; newScore: number; rank: null; topChanged: null }) {
  return {
    execute: jest.fn().mockResolvedValue(
      result ?? { userId: VALID_UUID, newScore: 100, rank: null, topChanged: null },
    ),
  };
}

function makeRepository(priorEvent?: ScoreEventRecord | null) {
  return {
    findByUserId: jest.fn(),
    credit: jest.fn(),
    findScoreEventByActionId: jest.fn().mockResolvedValue(priorEvent ?? null),
  };
}

function makeCounter() {
  return { inc: jest.fn() };
}

function makeRequest(userId = VALID_UUID) {
  return { userId };
}

function makeBody(overrides: Partial<{ actionId: string; delta: number }> = {}) {
  return { actionId: VALID_ACTION_UUID, delta: 10, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScoreboardController.incrementScore', () => {
  it('happy path returns handler result', async () => {
    const expectedResult = { userId: VALID_UUID, newScore: 100, rank: null, topChanged: null };
    const handler = makeHandler(expectedResult);
    const repo = makeRepository();
    const counter = makeCounter();
    const controller = new ScoreboardController(handler as never, repo as never, counter as never);

    const result = await controller.incrementScore(makeRequest(), makeBody());

    expect(result).toEqual(expectedResult);
    expect(handler.execute).toHaveBeenCalledTimes(1);
  });

  it('throws ZodError (400) for invalid body — non-UUID actionId', async () => {
    const handler = makeHandler();
    const repo = makeRepository();
    const counter = makeCounter();
    const controller = new ScoreboardController(handler as never, repo as never, counter as never);

    await expect(
      controller.incrementScore(makeRequest(), { actionId: 'not-a-uuid', delta: 10 }),
    ).rejects.toThrow();
  });

  it('throws ZodError (400) for delta = 0', async () => {
    const handler = makeHandler();
    const repo = makeRepository();
    const counter = makeCounter();
    const controller = new ScoreboardController(handler as never, repo as never, counter as never);

    await expect(
      controller.incrementScore(makeRequest(), { actionId: VALID_ACTION_UUID, delta: 0 }),
    ).rejects.toThrow();
  });

  it('idempotent replay returns prior result when prior event exists', async () => {
    const handler = {
      execute: jest.fn().mockRejectedValue(new IdempotencyViolationError(VALID_ACTION_UUID)),
    };
    const priorEvent: ScoreEventRecord = {
      actionId: VALID_ACTION_UUID,
      userId: VALID_UUID,
      delta: 10,
      totalScoreAfter: 200,
      occurredAt: new Date(),
    };
    const repo = makeRepository(priorEvent);
    const counter = makeCounter();
    const controller = new ScoreboardController(handler as never, repo as never, counter as never);

    const result = await controller.incrementScore(makeRequest(), makeBody());

    expect(result).toEqual({
      userId: VALID_UUID,
      newScore: 200,
      rank: null,
      topChanged: null,
    });
    expect(counter.inc).toHaveBeenCalledWith({ result: 'idempotent' });
  });

  it('throws InternalServerErrorException when idempotent replay has no prior event', async () => {
    const handler = {
      execute: jest.fn().mockRejectedValue(new IdempotencyViolationError(VALID_ACTION_UUID)),
    };
    const repo = makeRepository(null); // no prior event found
    const counter = makeCounter();
    const controller = new ScoreboardController(handler as never, repo as never, counter as never);

    await expect(
      controller.incrementScore(makeRequest(), makeBody()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('re-throws non-IdempotencyViolation errors', async () => {
    const handler = {
      execute: jest.fn().mockRejectedValue(new InvalidArgumentError('bad delta')),
    };
    const repo = makeRepository();
    const counter = makeCounter();
    const controller = new ScoreboardController(handler as never, repo as never, counter as never);

    await expect(
      controller.incrementScore(makeRequest(), makeBody()),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
