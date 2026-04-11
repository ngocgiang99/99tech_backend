import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type pino from 'pino';

import type { Database } from '../../infrastructure/db/schema.js';
import type { MetricsRegistry } from '../../observability/metrics-registry.js';
import type { CacheWiring } from '../../http/app.js';

import { createResourceRepository } from './infrastructure/repository.js';
import { CachedResourceRepository } from './infrastructure/cached-repository.js';
import { ResourceService } from './application/service.js';
import { createResourceController } from './presentation/controller.js';
import { createResourcesRouter } from './presentation/router.js';

export interface ResourcesDeps {
  db: Kysely<Database>;
  logger: pino.Logger;
  cache: CacheWiring;
  metrics?: MetricsRegistry;
}

export interface ResourcesModule {
  router: Router;
}

export function createResourcesModule(deps: ResourcesDeps): ResourcesModule {
  const { db, logger, cache, metrics } = deps;

  const pgRepository = createResourceRepository(db);
  const repository = cache.cacheEnabled
    ? new CachedResourceRepository({
        redis: cache.redis,
        inner: pgRepository,
        logger,
        detailTtlSeconds: cache.detailTtlSeconds,
        listTtlSeconds: cache.listTtlSeconds,
        listVersionKeyPrefix: cache.listVersionKeyPrefix,
        ...(metrics ? { metrics } : {}),
      })
    : pgRepository;

  const service = new ResourceService(repository);
  const ctrl = createResourceController(service, {
    cacheEnabled: cache.cacheEnabled,
    ...(metrics ? { metrics } : {}),
  });
  const router = createResourcesRouter(ctrl, cache.nodeEnv);

  return { router };
}
