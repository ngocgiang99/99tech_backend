// Mock jose before any imports — LeaderboardStreamController is decorated with
// @UseGuards(JwtGuard), which transitively imports jose (ESM-only).
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  errors: { JOSEError: class JOSEError extends Error {} },
}));

import { LeaderboardStreamController } from '../../../../src/scoreboard/interface/http/controllers/leaderboard-stream.controller';

// ---------------------------------------------------------------------------
// Fake reply — just enough to look like a FastifyReply with a writable raw.
// ---------------------------------------------------------------------------
function makeReply(): {
  write: jest.Mock;
  end: jest.Mock;
  raw: { write: jest.Mock; end: jest.Mock };
} {
  const write = jest.fn();
  const end = jest.fn();
  return {
    write,
    end,
    raw: { write, end },
  };
}

describe('LeaderboardStreamController#onApplicationShutdown', () => {
  it('writes the shutdown frame and ends each open stream, then clears the set', () => {
    const controller = new LeaderboardStreamController(
      {} as never,
      {} as never,
      {} as never,
    );
    const reply1 = makeReply();
    const reply2 = makeReply();
    const reply3 = makeReply();
    (controller as unknown as { openStreams: Set<unknown> }).openStreams.add(
      reply1,
    );
    (controller as unknown as { openStreams: Set<unknown> }).openStreams.add(
      reply2,
    );
    (controller as unknown as { openStreams: Set<unknown> }).openStreams.add(
      reply3,
    );

    controller.onApplicationShutdown('SIGTERM');

    for (const reply of [reply1, reply2, reply3]) {
      expect(reply.raw.write).toHaveBeenCalledWith(
        'event: shutdown\ndata: {"reason":"graceful"}\n\n',
      );
      expect(reply.raw.end).toHaveBeenCalledTimes(1);
    }

    expect(
      (controller as unknown as { openStreams: Set<unknown> }).openStreams.size,
    ).toBe(0);
  });

  it('swallows errors from already-closed streams and continues with the rest', () => {
    const controller = new LeaderboardStreamController(
      {} as never,
      {} as never,
      {} as never,
    );
    const good = makeReply();
    const bad = {
      raw: {
        write: jest.fn(() => {
          throw new Error('already ended');
        }),
        end: jest.fn(),
      },
    };
    (controller as unknown as { openStreams: Set<unknown> }).openStreams.add(
      bad,
    );
    (controller as unknown as { openStreams: Set<unknown> }).openStreams.add(
      good,
    );

    expect(() => controller.onApplicationShutdown('SIGTERM')).not.toThrow();
    expect(good.raw.write).toHaveBeenCalled();
    expect(
      (controller as unknown as { openStreams: Set<unknown> }).openStreams.size,
    ).toBe(0);
  });

  it('is a no-op when there are no open streams', () => {
    const controller = new LeaderboardStreamController(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(() => controller.onApplicationShutdown('SIGTERM')).not.toThrow();
    expect(
      (controller as unknown as { openStreams: Set<unknown> }).openStreams.size,
    ).toBe(0);
  });
});
