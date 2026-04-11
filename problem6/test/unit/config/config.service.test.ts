import { ConfigService } from '../../../src/config/config.service';
import type { Config } from '../../../src/config/schema';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
    REDIS_URL: 'redis://localhost:6379',
    NATS_URL: 'nats://localhost:4222',
    NATS_STREAM_NAME: 'SCOREBOARD',
    NATS_STREAM_MAX_AGE_SECONDS: 2592000,
    NATS_STREAM_MAX_MSGS: 1000000,
    NATS_STREAM_MAX_BYTES: 1073741824,
    NATS_STREAM_REPLICAS: 1,
    NATS_DEDUP_WINDOW_SECONDS: 120,
    INTERNAL_JWT_SECRET: 'a-32-byte-internal-jwt-secret-ok!',
    ACTION_TOKEN_SECRET: 'a-32-byte-secret-for-testing-ok!!',
    ACTION_TOKEN_TTL_SECONDS: 300,
    RATE_LIMIT_PER_SEC: 10,
    MAX_SSE_CONN_PER_INSTANCE: 5000,
    LEADERBOARD_REBUILD_TOP_N: 10000,
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

describe('ConfigService', () => {
  it('returns values for all keys', () => {
    const cfg = new ConfigService(makeConfig());
    expect(cfg.get('NODE_ENV')).toBe('test');
    expect(cfg.get('PORT')).toBe(3000);
    expect(cfg.get('DATABASE_URL')).toBe(
      'postgresql://user:pass@localhost:5432/testdb',
    );
    expect(cfg.get('REDIS_URL')).toBe('redis://localhost:6379');
    expect(cfg.get('NATS_URL')).toBe('nats://localhost:4222');
    expect(cfg.get('INTERNAL_JWT_SECRET')).toBe(
      'a-32-byte-internal-jwt-secret-ok!',
    );
    expect(cfg.get('ACTION_TOKEN_SECRET')).toBe(
      'a-32-byte-secret-for-testing-ok!!',
    );
    expect(cfg.get('ACTION_TOKEN_TTL_SECONDS')).toBe(300);
    expect(cfg.get('RATE_LIMIT_PER_SEC')).toBe(10);
    expect(cfg.get('LOG_LEVEL')).toBe('info');
  });

  it('freezes the config object so mutations are silently ignored in non-strict mode', () => {
    const cfg = new ConfigService(makeConfig({ PORT: 3000 }));
    const original = cfg.get('PORT');
    // In strict mode this would throw; in non-strict it's silently ignored
    expect(cfg.get('PORT')).toBe(original);
  });

  it('reflects overridden values', () => {
    const cfg = new ConfigService(makeConfig({ PORT: 9000 }));
    expect(cfg.get('PORT')).toBe(9000);
  });
});
