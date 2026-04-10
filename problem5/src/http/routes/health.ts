import { Router } from 'express';

import type { HealthCheckRegistry } from '../../shared/health.js';

export function createHealthRouter(registry: HealthCheckRegistry): Router {
  const router = Router();

  router.get('/healthz', async (req, res) => {
    // Liveness-only probe — always returns 200
    if (req.query['probe'] === 'liveness') {
      res.status(200).json({ status: 'ok', probe: 'liveness' });
      return;
    }

    const report = await registry.run();
    const statusCode = report.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(report);
  });

  return router;
}
