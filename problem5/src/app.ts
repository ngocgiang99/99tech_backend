import type express from 'express';
import type { Kysely } from 'kysely';
import type Redis from 'ioredis';
import type pino from 'pino';

import type { Config } from './config/env.js';
import type { Database } from './infrastructure/db/schema.js';
import { HealthCheckRegistry } from './shared/health.js';
import { dbHealthCheck } from './infrastructure/db/health.js';
import { cacheHealthCheck } from './infrastructure/cache/health.js';
import type { MetricsRegistry } from './observability/metrics-registry.js';
import { buildApp } from './http/app.js';

export interface Deps {
  config: Config;
  logger: pino.Logger;
  db: Kysely<Database>;
  redis: Redis;
  /**
   * Optional Prometheus metrics sink. When omitted (e.g. in unit tests that
   * don't care about telemetry) the HTTP middleware and `/metrics` route
   * are not mounted, the cache layer skips emitting counters, and the
   * controller skips outcome tracking. The decision is wired through
   * `MetricsWiring.enabled` based on `config.METRICS_ENABLED`.
   */
  metrics?: MetricsRegistry;
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
  const { config, logger, db, redis, metrics } = deps;

  const healthRegistry = new HealthCheckRegistry();
  healthRegistry.register('db', dbHealthCheck(db));
  healthRegistry.register('cache', cacheHealthCheck(redis));

  const extraScrubHeaders = config.LOG_SCRUBBER_EXTRA_HEADERS
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  const app = buildApp(
    logger,
    healthRegistry,
    db,
    {
      redis,
      cacheEnabled: config.CACHE_ENABLED,
      detailTtlSeconds: config.CACHE_DETAIL_TTL_SECONDS,
      listTtlSeconds: config.CACHE_LIST_TTL_SECONDS,
      listVersionKeyPrefix: config.CACHE_LIST_VERSION_KEY_PREFIX,
      nodeEnv: config.NODE_ENV,
    },
    metrics && config.METRICS_ENABLED ? { metrics, enabled: true } : undefined,
    { extraScrubHeaders },
  );

  return { app, healthRegistry };
}
