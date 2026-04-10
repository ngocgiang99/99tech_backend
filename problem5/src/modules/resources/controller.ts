import type { RequestHandler } from 'express';
import { ZodError } from 'zod';

import { ValidationError } from '../../lib/errors.js';
import type { Resource } from '../../db/schema.js';

import type { ResourceService } from './service.js';
import {
  CreateResourceSchema,
  UpdateResourceSchema,
  ListResourcesQuerySchema,
} from './schema.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(resource: Resource) {
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    status: resource.status,
    tags: resource.tags,
    ownerId: resource.owner_id,
    metadata: resource.metadata,
    createdAt: resource.created_at.toISOString(),
    updatedAt: resource.updated_at.toISOString(),
  };
}

function handleZodError(err: ZodError): ValidationError {
  const details = err.errors.map((e) => ({
    field: e.path.join('.'),
    message: e.message,
  }));
  return new ValidationError('Validation failed', details);
}

export interface ResourceController {
  create: RequestHandler;
  getById: RequestHandler;
  list: RequestHandler;
  update: RequestHandler;
  delete: RequestHandler;
}

export function createResourceController(service: ResourceService): ResourceController {
  const create: RequestHandler = async (req, res, next) => {
    try {
      const parseResult = CreateResourceSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw handleZodError(parseResult.error);
      }
      const resource = await service.create(parseResult.data);
      res.status(201).location(`/resources/${resource.id}`).json(toDto(resource));
    } catch (err) {
      next(err);
    }
  };

  const getById: RequestHandler = async (req, res, next) => {
    try {
      const id = req.params['id'];
      if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
        throw new ValidationError('id must be a valid UUID');
      }
      const resource = await service.getById(id);
      res.status(200).json(toDto(resource));
    } catch (err) {
      next(err);
    }
  };

  const list: RequestHandler = async (req, res, next) => {
    try {
      const parseResult = ListResourcesQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        throw handleZodError(parseResult.error);
      }
      const result = await service.list(parseResult.data);
      res.status(200).json({
        data: result.data.map(toDto),
        nextCursor: result.nextCursor,
      });
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
      next(err);
    }
  };

  return { create, getById, list, update, delete: deleteHandler };
}
