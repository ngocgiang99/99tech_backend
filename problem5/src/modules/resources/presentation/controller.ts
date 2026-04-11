import type { RequestHandler } from 'express';
import { ZodError } from 'zod';

import { NotFoundError, ValidationError } from '../../../shared/errors.js';
import type { MetricsRegistry } from '../../../observability/metrics-registry.js';
import type { ResourceService } from '../application/service.js';
import { createRequestContext, type CacheStatus } from '../application/request-context.js';
import {
  CreateResourceSchema,
  UpdateResourceSchema,
  ListResourcesQuerySchema,
} from '../schema.js';

import { toDto } from './mapper.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleZodError(err: ZodError): ValidationError {
  const details = err.errors.map((e) => ({
    path: e.path.join('.'),
    code: e.code,
    message: e.message,
  }));
  return new ValidationError('Request validation failed', details);
}

type ResourceOperation = 'create' | 'read' | 'list' | 'update' | 'delete';
type ResourceOutcome = 'success' | 'not_found' | 'validation_error' | 'error';

function classifyOutcome(err: unknown): Exclude<ResourceOutcome, 'success'> {
  if (err instanceof NotFoundError) return 'not_found';
  if (err instanceof ValidationError) return 'validation_error';
  return 'error';
}

export interface ResourceController {
  create: RequestHandler;
  getById: RequestHandler;
  list: RequestHandler;
  update: RequestHandler;
  delete: RequestHandler;
}

export interface ResourceControllerOptions {
  /**
   * When `false`, GET handlers skip the cache context entirely and stamp
   * every response with `X-Cache: BYPASS`. When `true`, the cache layer
   * reports HIT/MISS through the request context.
   */
  cacheEnabled: boolean;
  /**
   * Optional metrics sink. When provided, every controller method
   * increments `resources_operations_total{operation,outcome}` once per
   * request, classified by error type. Optional so unit tests can omit it.
   */
  metrics?: MetricsRegistry;
}

export function createResourceController(
  service: ResourceService,
  options: ResourceControllerOptions,
): ResourceController {
  const recordOutcome = (operation: ResourceOperation, outcome: ResourceOutcome): void => {
    options.metrics?.resourcesOperationsTotal.inc({ operation, outcome });
  };

  const markCacheStatus = (res: Parameters<RequestHandler>[1], status: CacheStatus): void => {
    res.locals['cacheStatus'] = status;
  };

  const create: RequestHandler = async (req, res, next) => {
    try {
      const parseResult = CreateResourceSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw handleZodError(parseResult.error);
      }
      const resource = await service.create(parseResult.data);
      res.status(201).location(`/resources/${resource.id}`).json(toDto(resource));
      recordOutcome('create', 'success');
    } catch (err) {
      recordOutcome('create', classifyOutcome(err));
      next(err);
    }
  };

  const getById: RequestHandler = async (req, res, next) => {
    try {
      const id = req.params['id'];
      if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
        throw new ValidationError('id must be a valid UUID');
      }
      if (!options.cacheEnabled) {
        markCacheStatus(res, 'BYPASS');
        const resource = await service.getById(id);
        res.status(200).json(toDto(resource));
        recordOutcome('read', 'success');
        return;
      }
      const ctx = createRequestContext();
      const resource = await service.getById(id, ctx);
      markCacheStatus(res, ctx.cacheStatus ?? 'MISS');
      res.status(200).json(toDto(resource));
      recordOutcome('read', 'success');
    } catch (err) {
      recordOutcome('read', classifyOutcome(err));
      next(err);
    }
  };

  const list: RequestHandler = async (req, res, next) => {
    try {
      const parseResult = ListResourcesQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw handleZodError(parseResult.error);
      }
      if (!options.cacheEnabled) {
        markCacheStatus(res, 'BYPASS');
        const result = await service.list(parseResult.data);
        res.status(200).json({
          data: result.data.map(toDto),
          nextCursor: result.nextCursor,
        });
        recordOutcome('list', 'success');
        return;
      }
      const ctx = createRequestContext();
      const result = await service.list(parseResult.data, ctx);
      markCacheStatus(res, ctx.cacheStatus ?? 'MISS');
      res.status(200).json({
        data: result.data.map(toDto),
        nextCursor: result.nextCursor,
      });
      recordOutcome('list', 'success');
    } catch (err) {
      recordOutcome('list', classifyOutcome(err));
      next(err);
    }
  };

  const update: RequestHandler = async (req, res, next) => {
    try {
      const id = req.params['id'];
      if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
        throw new ValidationError('id must be a valid UUID');
      }
      const parseResult = UpdateResourceSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw handleZodError(parseResult.error);
      }
      const resource = await service.update(id, parseResult.data);
      res.status(200).json(toDto(resource));
      recordOutcome('update', 'success');
    } catch (err) {
      recordOutcome('update', classifyOutcome(err));
      next(err);
    }
  };

  const deleteHandler: RequestHandler = async (req, res, next) => {
    try {
      const id = req.params['id'];
      if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
        throw new ValidationError('id must be a valid UUID');
      }
      await service.delete(id);
      res.status(204).send();
      recordOutcome('delete', 'success');
    } catch (err) {
      recordOutcome('delete', classifyOutcome(err));
      next(err);
    }
  };

  return { create, getById, list, update, delete: deleteHandler };
}
