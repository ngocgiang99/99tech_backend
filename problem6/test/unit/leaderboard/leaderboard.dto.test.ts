import { LeaderboardTopQuerySchema } from '../../../src/scoreboard/interface/http/dto/leaderboard.dto';

describe('LeaderboardTopQuerySchema', () => {
  it('parses a valid limit', () => {
    const result = LeaderboardTopQuerySchema.safeParse({ limit: '5' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(5);
  });

  it('defaults limit to 10 when not provided', () => {
    const result = LeaderboardTopQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(10);
  });

  it('rejects limit > 100', () => {
    const result = LeaderboardTopQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
  });

  it('rejects limit < 1', () => {
    const result = LeaderboardTopQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });

  it('coerces string to number', () => {
    const result = LeaderboardTopQuerySchema.safeParse({ limit: '50' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(50);
  });

  it('rejects non-integer float', () => {
    const result = LeaderboardTopQuerySchema.safeParse({ limit: '5.5' });
    expect(result.success).toBe(false);
  });
});
