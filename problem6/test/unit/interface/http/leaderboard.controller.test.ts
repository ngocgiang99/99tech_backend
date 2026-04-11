// ---------------------------------------------------------------------------
// Mock jose before any imports — JwtGuard imports jose (ESM-only; requires mocking
// in Jest's CommonJS environment since the controller transitively imports JwtGuard)
// ---------------------------------------------------------------------------
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  errors: { JOSEError: class JOSEError extends Error {} },
}));

import { ValidationError } from '../../../../src/scoreboard/shared/errors';

import { LeaderboardController } from '../../../../src/scoreboard/interface/http/controllers/leaderboard.controller';
import type { GetLeaderboardTopHandler } from '../../../../src/scoreboard/application/queries';
import type { TopEntry } from '../../../../src/scoreboard/domain/ports/user-score.repository';

function makeEntry(rank: number, userId: string, score: number): TopEntry {
  return { rank, userId, score, updatedAt: new Date('2026-01-01T00:00:00Z') };
}

function makeHandlerMock(
  result: { source: 'hit' | 'miss'; entries: TopEntry[] } | Error,
): GetLeaderboardTopHandler {
  return {
    execute: jest.fn().mockImplementation(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  } as unknown as GetLeaderboardTopHandler;
}

function makeResMock(): { header: jest.Mock } {
  return { header: jest.fn() };
}

describe('LeaderboardController unit tests', () => {
  it('HIT path with entries → X-Cache-Status: hit', async () => {
    const entries = [makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 200)];
    const handler = makeHandlerMock({ source: 'hit', entries });
    const controller = new LeaderboardController(handler);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '5' } as unknown,
      res as never,
    );

    expect(result.entries).toEqual(entries);
    expect(typeof result.generatedAt).toBe('string');
    expect(res.header).toHaveBeenCalledWith('X-Cache-Status', 'hit');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(handler.execute).toHaveBeenCalledWith(5);
  });

  it('HIT path with empty entries → X-Cache-Status: hit, entries: []', async () => {
    const handler = makeHandlerMock({ source: 'hit', entries: [] });
    const controller = new LeaderboardController(handler);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '10' } as unknown,
      res as never,
    );

    expect(result.entries).toEqual([]);
    expect(res.header).toHaveBeenCalledWith('X-Cache-Status', 'hit');
  });

  it('MISS path → X-Cache-Status: miss, handler-provided entries returned', async () => {
    const entries = [
      makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 300),
      makeEntry(2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 200),
    ];
    const handler = makeHandlerMock({ source: 'miss', entries });
    const controller = new LeaderboardController(handler);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '10' } as unknown,
      res as never,
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ rank: 1, score: 300 });
    expect(result.entries[1]).toMatchObject({ rank: 2, score: 200 });
    expect(res.header).toHaveBeenCalledWith('X-Cache-Status', 'miss');
  });

  it('limit > 100 → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeHandlerMock({ source: 'hit', entries: [] }),
    );
    await expect(
      controller.getTop({ limit: '101' } as unknown, makeResMock() as never),
    ).rejects.toThrow(ValidationError);
  });

  it('limit < 1 → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeHandlerMock({ source: 'hit', entries: [] }),
    );
    await expect(
      controller.getTop({ limit: '0' } as unknown, makeResMock() as never),
    ).rejects.toThrow(ValidationError);
  });

  it('invalid string limit → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeHandlerMock({ source: 'hit', entries: [] }),
    );
    await expect(
      controller.getTop(
        { limit: 'notanumber' } as unknown,
        makeResMock() as never,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('no limit param → defaults to 10, handler.execute called with 10', async () => {
    const handler = makeHandlerMock({
      source: 'hit',
      entries: [makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100)],
    });
    const controller = new LeaderboardController(handler);
    await controller.getTop({} as unknown, makeResMock() as never);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(handler.execute).toHaveBeenCalledWith(10);
  });

  it('generatedAt is a valid ISO date string', async () => {
    const handler = makeHandlerMock({
      source: 'hit',
      entries: [makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100)],
    });
    const controller = new LeaderboardController(handler);
    const result = await controller.getTop(
      { limit: '1' } as unknown,
      makeResMock() as never,
    );
    expect(() => new Date(result.generatedAt)).not.toThrow();
    expect(new Date(result.generatedAt).getTime()).not.toBeNaN();
  });
});
