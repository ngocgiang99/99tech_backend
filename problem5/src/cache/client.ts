import Redis, { type RedisOptions } from 'ioredis';

export interface RedisConfig {
  url: string;
}

export function createRedis(config: RedisConfig): Redis {
  const options: RedisOptions = {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET'];
      return targetErrors.some((code) => err.message.includes(code));
    },
  };

  return new Redis(config.url, options);
}
