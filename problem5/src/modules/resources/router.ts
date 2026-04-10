import { Router } from 'express';
import type { Kysely } from 'kysely';
import type pino from 'pino';

import type { Database } from '../../db/schema.js';
import type { CacheWiring } from '../../http/app.js';
import { xCacheMiddleware } from '../../middleware/x-cache.js';

import { createResourceRepository } from './repository.js';
import { CachedResourceRepository } from './cached-repository.js';
import { ResourceService } from './service.js';
import { createResourceController } from './controller.js';

export function createResourcesRouter(
  db: Kysely<Database>,
  cache: CacheWiring,
  logger: pino.Logger,
): Router {
  const router = Router();

  const pgRepository = createResourceRepository(db);
  const repository = cache.cacheEnabled
    ? new CachedResourceRepository({
        redis: cache.redis,
        inner: pgRepository,
        logger,
        detailTtlSeconds: cache.detailTtlSeconds,
        listTtlSeconds: cache.listTtlSeconds,
        listVersionKeyPrefix: cache.listVersionKeyPrefix,
      })
    : pgRepository;

  const service = new ResourceService(repository);
  const ctrl = createResourceController(service, { cacheEnabled: cache.cacheEnabled });

  // X-Cache header middleware — only on resource routes (not global).
  // Emits in dev/test, suppressed in production to avoid cache-state disclosure.
  router.use(xCacheMiddleware(cache.nodeEnv));

  router.post('/', ctrl.create);
  router.get('/', ctrl.list);
  router.get('/:id', ctrl.getById);
  router.patch('/:id', ctrl.update);
  router.delete('/:id', ctrl.delete);

  return router;
}
