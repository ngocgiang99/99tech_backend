import { Router } from 'express';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';

import { createResourceRepository } from './repository.js';
import { ResourceService } from './service.js';
import { createResourceController } from './controller.js';

export function createResourcesRouter(db: Kysely<Database>): Router {
  const router = Router();

  const repository = createResourceRepository(db);
  const service = new ResourceService(repository);
  const ctrl = createResourceController(service);

  router.post('/', ctrl.create);
  router.get('/', ctrl.list);
  router.get('/:id', ctrl.getById);
  router.patch('/:id', ctrl.update);
  router.delete('/:id', ctrl.delete);

  return router;
}
