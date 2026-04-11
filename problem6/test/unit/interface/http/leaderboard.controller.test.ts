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
import type {
  LeaderboardCache,
  LeaderboardEntry,
} from '../../../../src/scoreboard/domain/ports/leaderboard-cache';
import type { Database } from '../../../../src/database/database.factory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  rank: number,
  userId: string,
  score: number,
): LeaderboardEntry {
  return { rank, userId, score, updatedAt: new Date('2026-01-01T00:00:00Z') };
}

function makeCacheMock(topEntries: LeaderboardEntry[]): LeaderboardCache {
  return {
    upsert: jest.fn(),
    getTop: jest.fn().mockResolvedValue(topEntries),
    getRank: jest.fn().mockResolvedValue(null),
  };
}

function makeDbMock(
  rows: Array<{
    user_id: string;
    total_score: number | bigint;
    updated_at: string;
  }>,
): Database {
  const builder = {
    select: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    execute: jest.fn().mockResolvedValue(rows),
  };
  return {
    selectFrom: jest.fn().mockReturnValue(builder),
  } as unknown as Database;
}

function makeResMock(): { header: jest.Mock } {
  return { header: jest.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LeaderboardController unit tests', () => {
  it('cache hit — returns entries from cache, no DB query, no header set', async () => {
    const entries = [makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 200)];
    const cache = makeCacheMock(entries);
    const db = makeDbMock([]);
    const controller = new LeaderboardController(cache, db);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '5' } as unknown,
      res as never,
    );

    expect(result.entries).toEqual(entries);
    expect(typeof result.generatedAt).toBe('string');
    expect((db.selectFrom as jest.Mock).mock.calls).toHaveLength(0);
    expect(res.header).not.toHaveBeenCalled();
  });

  it('empty cache → falls back to DB, sets X-Cache-Status header, maps rows to entries', async () => {
    const cache = makeCacheMock([]);
    const dbRows = [
      {
        user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        total_score: 300,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        total_score: 200,
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    const db = makeDbMock(dbRows);
    const controller = new LeaderboardController(cache, db);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '10' } as unknown,
      res as never,
    );

    expect(result.entries).toHaveLength(2);
    const e = result.entries as Array<{
      rank: number;
      userId: string;
      score: number;
    }>;
    expect(e[0]).toMatchObject({
      rank: 1,
      userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      score: 300,
    });
    expect(e[1]).toMatchObject({
      rank: 2,
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      score: 200,
    });
    expect(res.header).toHaveBeenCalledWith('X-Cache-Status', 'miss-fallback');
  });

  it('limit > 100 → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeCacheMock([]),
      makeDbMock([]),
    );
    await expect(
      controller.getTop({ limit: '101' } as unknown, makeResMock() as never),
    ).rejects.toThrow(ValidationError);
  });

  it('limit < 1 → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeCacheMock([]),
      makeDbMock([]),
    );
    await expect(
      controller.getTop({ limit: '0' } as unknown, makeResMock() as never),
    ).rejects.toThrow(ValidationError);
  });

  it('invalid string limit → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeCacheMock([]),
      makeDbMock([]),
    );
    await expect(
      controller.getTop(
        { limit: 'notanumber' } as unknown,
        makeResMock() as never,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('no limit param → defaults to 10, cache.getTop called with 10', async () => {
    const cache = makeCacheMock([
      makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100),
    ]);
    const controller = new LeaderboardController(cache, makeDbMock([]));
    await controller.getTop({} as unknown, makeResMock() as never);
    expect(cache.getTop).toHaveBeenCalledWith(10);
  });

  it('generatedAt is a valid ISO date string', async () => {
    const cache = makeCacheMock([
      makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100),
    ]);
    const controller = new LeaderboardController(cache, makeDbMock([]));
    const result = await controller.getTop(
      { limit: '1' } as unknown,
      makeResMock() as never,
    );
    expect(() => new Date(result.generatedAt)).not.toThrow();
    expect(new Date(result.generatedAt).getTime()).not.toBeNaN();
  });
});
