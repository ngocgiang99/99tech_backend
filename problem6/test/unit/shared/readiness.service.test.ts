import { ReadinessService } from '../../../src/shared/readiness/readiness.service';

describe('ReadinessService', () => {
  let service: ReadinessService;

  beforeEach(() => {
    service = new ReadinessService();
  });

  it('defaults leaderboardReady to false', () => {
    expect(service.leaderboardReady).toBe(false);
  });

  it('setter updates leaderboardReady to true', () => {
    service.leaderboardReady = true;
    expect(service.leaderboardReady).toBe(true);
  });

  it('setter can toggle back to false', () => {
    service.leaderboardReady = true;
    service.leaderboardReady = false;
    expect(service.leaderboardReady).toBe(false);
  });
});
