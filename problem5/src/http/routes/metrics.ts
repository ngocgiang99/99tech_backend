import { Router } from 'express';

import type { MetricsRegistry } from '../../observability/metrics-registry.js';

/**
 * `GET /metrics` — Prometheus exposition format.
 *
 * The route uses `registry.contentType` (which prom-client sets to
 * `text/plain; version=0.0.4; charset=utf-8` for the v0.0.4 format) so the
 * `Content-Type` header is consistent with whatever serialization the
 * registry would produce.
 *
 * When `METRICS_ENABLED=false`, the wiring layer simply does not mount this
 * router (rather than mounting a 404 handler). That makes the disabled
 * state observable to a scraper as "no such endpoint" instead of "endpoint
 * exists but returns nothing".
 */
export function createMetricsRouter(metrics: MetricsRegistry): Router {
  const router = Router();

  router.get('/metrics', async (_req, res, next) => {
    try {
      const body = await metrics.render();
      res.setHeader('Content-Type', metrics.registry.contentType);
      res.status(200).send(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
