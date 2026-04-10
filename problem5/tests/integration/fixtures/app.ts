import pino from 'pino';
import supertest from 'supertest';

import { loadConfig } from '../../../src/config/env.js';
import { createDb } from '../../../src/db/client.js';
import { createRedis } from '../../../src/cache/client.js';
import { createApp } from '../../../src/app.js';
import type { Deps } from '../../../src/app.js';

export interface TestAppContext {
  request: ReturnType<typeof supertest>;
  deps: Deps;
  close: () => Promise<void>;
}

/**
 * Builds an app instance wired to the Testcontainers Postgres + Redis
 * via DATABASE_URL / REDIS_URL set by the global setup. Returns a
 * supertest agent ready for HTTP assertions plus a close hook tests
 * should call in `afterAll`.
 */
export async function createTestApp(
  envOverrides: Record<string, string> = {},
): Promise<TestAppContext> {
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;

  const config = loadConfig();
  const logger = pino({ level: 'silent' });

  const { db, pool } = createDb({
    connectionString: config.DATABASE_URL,
    maxConnections: config.DB_POOL_MAX,
  });
  const redis = createRedis({ url: config.REDIS_URL });

  // Wait for the Redis client to finish its TCP handshake. Without this,
  // the very first request (e.g. /healthz) can race the connection and
  // see "Stream isn't writeable" because enableOfflineQueue is false in
  // the production ioredis defaults. Production masks this via the
  // docker healthcheck + start_period; tests hit the app instantly.
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        redis.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        redis.off('ready', onReady);
        reject(err);
      };
      redis.once('ready', onReady);
      redis.once('error', onError);
    });
  }

  const deps: Deps = { config, logger, db, redis };
  const { app } = createApp(deps);

  const close = async (): Promise<void> => {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    await pool.end();
  };

  return { request: supertest(app), deps, close };
}
