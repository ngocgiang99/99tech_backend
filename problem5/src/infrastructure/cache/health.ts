import type Redis from 'ioredis';

import type { CheckResult } from '../../shared/health.js';

const PING_TIMEOUT_MS = 1000;

export function cacheHealthCheck(redis: Redis): () => Promise<CheckResult> {
  return async () => {
    try {
      const result = await Promise.race([
        redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PING timeout')), PING_TIMEOUT_MS),
        ),
      ]);
      if (result === 'PONG') {
        return { status: 'up' };
      }
      return { status: 'down', error: `Unexpected PING response: ${String(result)}` };
    } catch (err) {
      return {
        status: 'down',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
