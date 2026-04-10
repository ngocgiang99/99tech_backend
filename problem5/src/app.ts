import type express from 'express';
import type { Kysely } from 'kysely';
import type Redis from 'ioredis';
import type pino from 'pino';

import type { Config } from './config/env.js';
import type { Database } from './infrastructure/db/schema.js';
import { HealthCheckRegistry } from './shared/health.js';
import { dbHealthCheck } from './infrastructure/db/health.js';
import { cacheHealthCheck } from './infrastructure/cache/health.js';
import { buildApp } from './http/app.js';

export interface Deps {
  config: Config;
  logger: pino.Logger;
  db: Kysely<Database>;
  redis: Redis;
}

export interface AppBundle {
  app: express.Express;
  healthRegistry: HealthCheckRegistry;
}

/**
 * Pure factory: given real (or test) clients, wire health checks and
 * return the Express app plus the health registry. This is the single
 * source of truth for how the app is constructed — `src/index.ts` calls
 * it with production clients; integration tests call it with Testcontainers
 * clients. No module-level side effects live here.
 */
export function createApp(deps: Deps): AppBundle {
  const { config, logger, db, redis } = deps;

  const healthRegistry = new HealthCheckRegistry();
  healthRegistry.register('db', dbHealthCheck(db));
  healthRegistry.register('cache', cacheHealthCheck(redis));

  const app = buildApp(logger, healthRegistry, db, {
    redis,
    cacheEnabled: config.CACHE_ENABLED,
    detailTtlSeconds: config.CACHE_DETAIL_TTL_SECONDS,
    listTtlSeconds: config.CACHE_LIST_TTL_SECONDS,
    listVersionKeyPrefix: config.CACHE_LIST_VERSION_KEY_PREFIX,
    nodeEnv: config.NODE_ENV,
  });

  return { app, healthRegistry };
}
