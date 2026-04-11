import express from 'express';
import type pino from 'pino';
import pinoHttp from 'pino-http';
import type { Kysely } from 'kysely';
import type Redis from 'ioredis';

import { createErrorHandler, type ErrorHandlerOptions } from '../middleware/error-handler.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import type { HealthCheckRegistry } from '../shared/health.js';
import type { Database } from '../infrastructure/db/schema.js';
import type { MetricsRegistry } from '../observability/metrics-registry.js';
import { createHttpMetricsMiddleware } from '../observability/http-metrics.js';
import { createResourcesModule } from '../modules/resources/index.js';

import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';

export interface CacheWiring {
  redis: Redis;
  cacheEnabled: boolean;
  detailTtlSeconds: number;
  listTtlSeconds: number;
  listVersionKeyPrefix: string;
  nodeEnv: string;
}

export interface MetricsWiring {
  metrics: MetricsRegistry;
  enabled: boolean;
}

export function buildApp(
  logger: pino.Logger,
  healthRegistry: HealthCheckRegistry,
  db: Kysely<Database>,
  cache: CacheWiring,
  metricsWiring?: MetricsWiring,
  errorHandlerOpts?: ErrorHandlerOptions,
): express.Express {
  const app = express();

  // Request ID (must be first)
  app.use(requestIdMiddleware);

  // HTTP metrics — installed early so the `res.on('finish')` listener fires
  // for every downstream route. The middleware reads `req.route` at finish
  // time, after the router has populated it. The middleware itself is a
  // no-op pass-through except for the side-effect of recording.
  if (metricsWiring?.enabled) {
    app.use(createHttpMetricsMiddleware(metricsWiring.metrics));
  }

  // Structured HTTP request logging
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id as string,
    }),
  );

  // Body parsing (64 KB limit)
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false }));

  // Routes — metrics first so a scrape against /metrics never falls into
  // the resources router by accident, then health, then the feature module.
  if (metricsWiring?.enabled) {
    app.use(createMetricsRouter(metricsWiring.metrics));
  }
  app.use(createHealthRouter(healthRegistry));
  const resources = createResourcesModule({
    db,
    cache,
    logger,
    ...(metricsWiring?.enabled ? { metrics: metricsWiring.metrics } : {}),
  });
  app.use('/resources', resources.router);

  // Central error handler (must be last)
  app.use(createErrorHandler(logger, {
    ...(errorHandlerOpts ?? {}),
    ...(metricsWiring?.enabled ? { metrics: metricsWiring.metrics } : {}),
  }));

  return app;
}
