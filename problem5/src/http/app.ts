import express from 'express';
import type pino from 'pino';
import pinoHttp from 'pino-http';
import type { Kysely } from 'kysely';

import { createErrorHandler } from '../middleware/error-handler.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import type { HealthCheckRegistry } from '../lib/health.js';
import type { Database } from '../db/schema.js';
import { createResourcesRouter } from '../modules/resources/router.js';

import { createHealthRouter } from './routes/health.js';

export function buildApp(
  logger: pino.Logger,
  healthRegistry: HealthCheckRegistry,
  db: Kysely<Database>,
): express.Express {
  const app = express();

  // Request ID (must be first)
  app.use(requestIdMiddleware);

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

  // Routes
  app.use(createHealthRouter(healthRegistry));
  app.use('/resources', createResourcesRouter(db));

  // Central error handler (must be last)
  app.use(createErrorHandler(logger));

  return app;
}
