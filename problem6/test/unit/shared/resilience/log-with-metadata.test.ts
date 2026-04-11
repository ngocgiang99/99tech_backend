import { logWithMetadata } from '../../../../src/scoreboard/shared/resilience/log-with-metadata';
import type { StructuredLogger } from '../../../../src/scoreboard/shared/resilience/log-with-metadata';

interface EmittedPayload {
  err: {
    errorClass: string;
    errorId: string;
    method: string;
    route: string;
    cause: unknown[];
    pgCode?: string;
  };
  source?: string;
  aggregateId?: string;
}

function makeLogger(includeFatal = true): StructuredLogger & {
  warn: jest.Mock;
  error: jest.Mock;
  fatal?: jest.Mock;
} {
  return {
    warn: jest.fn(),
    error: jest.fn(),
    ...(includeFatal ? { fatal: jest.fn() } : {}),
  };
}

function firstCall(mock: jest.Mock): [EmittedPayload, string] {
  const [payload, msg] = mock.mock.calls[0] as [EmittedPayload, string];
  return [payload, msg];
}

describe('logWithMetadata', () => {
  it('emits at error level with metadata object and merges context fields', () => {
    const logger = makeLogger();
    const err = new Error('outbox publish failed');

    logWithMetadata(logger, 'error', err, {
      source: 'outbox-publish',
      aggregateId: 'user-123',
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, msg] = firstCall(logger.error);
    expect(msg).toBe('Error logged with metadata');
    expect(payload).toMatchObject({
      source: 'outbox-publish',
      aggregateId: 'user-123',
    });
    expect(payload.err.errorClass).toBe('InternalError');
    expect(payload.err.errorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('wraps a non-Error value into InternalError and emits without throwing', () => {
    const logger = makeLogger();

    logWithMetadata(logger, 'warn', 'raw string failure');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload] = firstCall(logger.warn);
    expect(payload.err.errorClass).toBe('InternalError');
    // walkCause only descends through Error instances, so the string cause
    // does not appear in the walked chain — the chain is empty.
    expect(payload.err.cause).toEqual([]);
  });

  it('produces BACKGROUND method and __background route when no source is supplied', () => {
    const logger = makeLogger();

    logWithMetadata(logger, 'error', new Error('x'));

    const [payload] = firstCall(logger.error);
    expect(payload.err.method).toBe('BACKGROUND');
    expect(payload.err.route).toBe('__background');
  });

  it('honours context.source as the route override', () => {
    const logger = makeLogger();

    logWithMetadata(logger, 'error', new Error('x'), {
      source: 'leaderboard-rebuilder',
    });

    const [payload] = firstCall(logger.error);
    expect(payload.err.route).toBe('leaderboard-rebuilder');
    expect(payload.source).toBe('leaderboard-rebuilder');
  });

  it('delegates pg-shaped errors through mapDbError (23505 → ConflictError + pgCode)', () => {
    const logger = makeLogger();
    const pgErr = {
      code: '23505',
      name: 'error',
      message: 'duplicate key',
    } as unknown;

    logWithMetadata(logger, 'error', pgErr);

    const [payload] = firstCall(logger.error);
    expect(payload.err.errorClass).toBe('ConflictError');
    expect(payload.err.pgCode).toBe('23505');
  });

  it('falls back to error when fatal is requested but logger lacks a fatal method', () => {
    const logger = makeLogger(false);

    logWithMetadata(logger, 'fatal', new Error('boom'));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toBeUndefined();
  });

  it('uses fatal when available and requested', () => {
    const logger = makeLogger();

    logWithMetadata(logger, 'fatal', new Error('boom'));

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
