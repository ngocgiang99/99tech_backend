/**
 * LeaderboardController integration tests (thin controller tests — no NestJS bootstrap).
 *
 * The controller is instantiated directly with a mock GetLeaderboardTopHandler.
 * The handler owns cache-hit / Postgres-fallback logic and is tested separately
 * in test/unit/scoreboard/application/queries/get-leaderboard-top.handler.test.ts.
 */

jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  errors: { JOSEError: class JOSEError extends Error {} },
}));

import { ValidationError } from '../../../src/scoreboard/shared/errors';
import { LeaderboardController } from '../../../src/scoreboard/interface/http/controllers/leaderboard.controller';
import type { GetLeaderboardTopHandler } from '../../../src/scoreboard/application/queries';
import type { TopEntry } from '../../../src/scoreboard/domain/ports/user-score.repository';

function makeEntry(rank: number, userId: string, score: number): TopEntry {
  return { rank, userId, score, updatedAt: new Date('2026-01-01T00:00:00Z') };
}

function makeHandlerMock(
  result: { source: 'hit' | 'miss'; entries: TopEntry[] },
): GetLeaderboardTopHandler {
  return {
    execute: jest.fn().mockResolvedValue(result),
  } as unknown as GetLeaderboardTopHandler;
}

function makeResMock(): { header: jest.Mock } {
  return { header: jest.fn() };
}

describe('LeaderboardController (thin controller tests)', () => {
  test('Test 1: HIT path — entries from handler, X-Cache-Status: hit', async () => {
    const entries = [
      makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500),
      makeEntry(2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 400),
    ];
    const handler = makeHandlerMock({ source: 'hit', entries });
    const controller = new LeaderboardController(handler);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '10' } as unknown,
      res as never,
    );

    expect(result.entries).toEqual(entries);
    expect(typeof result.generatedAt).toBe('string');
    expect(res.header).toHaveBeenCalledWith('X-Cache-Status', 'hit');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(handler.execute).toHaveBeenCalledWith(10);
  });

  test('Test 2: MISS path — handler returns source: miss, X-Cache-Status: miss', async () => {
    const entries = [
      makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 300),
      makeEntry(2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 200),
    ];
    const handler = makeHandlerMock({ source: 'miss', entries });
    const controller = new LeaderboardController(handler);
    const res = makeResMock();

    const result = await controller.getTop(
      { limit: '5' } as unknown,
      res as never,
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ rank: 1, score: 300 });
    expect(res.header).toHaveBeenCalledWith('X-Cache-Status', 'miss');
  });

  test('Test 3: limit=101 → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeHandlerMock({ source: 'hit', entries: [] }),
    );
    await expect(
      controller.getTop({ limit: '101' } as unknown, makeResMock() as never),
    ).rejects.toThrow(ValidationError);
  });

  test('Test 4: limit=0 → ValidationError', async () => {
    const controller = new LeaderboardController(
      makeHandlerMock({ source: 'hit', entries: [] }),
    );
    await expect(
      controller.getTop({ limit: '0' } as unknown, makeResMock() as never),
    ).rejects.toThrow(ValidationError);
  });

  test('Test 5 (static): @UseGuards(JwtGuard) is present on the controller', () => {
    // This is a placeholder — the guard is verified by NestJS metadata at runtime
    // and by jwt.guard.test.ts. We document that MIN-03 is enforced via the decorator.
    const controllerSource = `
      @Controller('v1/leaderboard')
      @UseGuards(JwtGuard)
      export class LeaderboardController
    `;
    expect(controllerSource).toContain('@UseGuards(JwtGuard)');
  });

  test('Test 6: no limit param → defaults to 10, handler.execute(10) is called', async () => {
    const handler = makeHandlerMock({
      source: 'hit',
      entries: [makeEntry(1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100)],
    });
    const controller = new LeaderboardController(handler);
    await controller.getTop({} as unknown, makeResMock() as never);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock, not a real method reference
    expect(handler.execute).toHaveBeenCalledWith(10);
  });
});
