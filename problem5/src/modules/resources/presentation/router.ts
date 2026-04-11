import { Router } from 'express';

import { xCacheMiddleware } from '../../../middleware/x-cache.js';

import type { ResourceController } from './controller.js';

export function createResourcesRouter(ctrl: ResourceController, nodeEnv: string): Router {
  const router = Router();

  // X-Cache header middleware — only on resource routes (not global).
  // Emits in dev/test, suppressed in production to avoid cache-state disclosure.
  router.use(xCacheMiddleware(nodeEnv));

  router.post('/', ctrl.create);
  router.get('/', ctrl.list);
  router.get('/:id', ctrl.getById);
  router.patch('/:id', ctrl.update);
  router.delete('/:id', ctrl.delete);

  return router;
}
