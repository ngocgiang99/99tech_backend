import { GetLeaderboardTopHandler } from '../../../../../src/scoreboard/application/queries';
import type { LeaderboardCache } from '../../../../../src/scoreboard/domain/ports/leaderboard-cache';
import type {
  TopEntry,
  UserScoreRepository,
} from '../../../../../src/scoreboard/domain/ports/user-score.repository';

function makeEntry(rank: number, userId: string, score: number): TopEntry {
  return { rank, userId, score, updatedAt: new Date('2026-01-01T00:00:00Z') };
}

function makeCache(overrides: Partial<LeaderboardCache>): LeaderboardCache {
  return {
    upsert: jest.fn(),
    getTop: jest.fn(),
    getRank: jest.fn(),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<UserScoreRepository>): UserScoreRepository {
  return {
    findByUserId: jest.fn(),
    credit: jest.fn(),
    findScoreEventByActionId: jest.fn(),
    findTopN: jest.fn(),
    ...overrides,
  } as unknown as UserScoreRepository;
}

describe('GetLeaderboardTopHandler.execute', () => {
  it('returns source: hit when the cache succeeds', async () => {
    const entries = [
      makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 300),
      makeEntry(2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 200),
    ];
    const cache = makeCache({
      getTop: jest.fn().mockResolvedValue(entries),
    });
    const repo = makeRepo({});
    const handler = new GetLeaderboardTopHandler(cache, repo);

    const result = await handler.execute(10);

    expect(result).toEqual({ source: 'hit', entries });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(cache.getTop).toHaveBeenCalledWith(10);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(repo.findTopN).not.toHaveBeenCalled();
  });

  it('returns source: hit with an empty array when the cache returns []', async () => {
    const cache = makeCache({
      getTop: jest.fn().mockResolvedValue([]),
    });
    const repo = makeRepo({});
    const handler = new GetLeaderboardTopHandler(cache, repo);

    const result = await handler.execute(5);

    expect(result).toEqual({ source: 'hit', entries: [] });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(repo.findTopN).not.toHaveBeenCalled();
  });

  it('falls back to repo.findTopN with source: miss when the cache throws', async () => {
    const entries = [makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 300)];
    const cache = makeCache({
      getTop: jest.fn().mockRejectedValue(new Error('Redis unreachable')),
    });
    const repo = makeRepo({
      findTopN: jest.fn().mockResolvedValue(entries),
    });
    const handler = new GetLeaderboardTopHandler(cache, repo);

    const result = await handler.execute(10);

    expect(result).toEqual({ source: 'miss', entries });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(repo.findTopN).toHaveBeenCalledWith(10);
  });

  it('propagates repo errors when both cache and repo fail', async () => {
    const cache = makeCache({
      getTop: jest.fn().mockRejectedValue(new Error('Redis unreachable')),
    });
    const repo = makeRepo({
      findTopN: jest.fn().mockRejectedValue(new Error('Postgres unreachable')),
    });
    const handler = new GetLeaderboardTopHandler(cache, repo);

    await expect(handler.execute(10)).rejects.toThrow('Postgres unreachable');
  });
});
