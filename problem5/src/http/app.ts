import express from 'express';
import type pino from 'pino';
import pinoHttp from 'pino-http';

import { createErrorHandler } from '../middleware/error-handler.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import type { HealthCheckRegistry } from '../lib/health.js';

import { createHealthRouter } from './routes/health.js';

export function buildApp(logger: pino.Logger, healthRegistry: HealthCheckRegistry): express.Express {
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

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Routes
  app.use(createHealthRouter(healthRegistry));

  // Central error handler (must be last)
  app.use(createErrorHandler(logger));

  return app;
}
