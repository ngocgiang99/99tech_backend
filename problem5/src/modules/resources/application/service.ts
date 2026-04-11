import { NotFoundError } from '../../../shared/errors.js';
import type { Resource } from '../../../infrastructure/db/schema.js';
import type { ResourceRepository, ListResult } from '../infrastructure/repository.js';
import type { CreateResourceInput, UpdateResourceInput, ListResourcesQuery } from '../schema.js';

import type { RequestContext } from './request-context.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export interface ListResponse {
  data: Resource[];
  nextCursor: string | null;
}

export class ResourceService {
  constructor(private readonly repo: ResourceRepository) {}

  async create(input: CreateResourceInput, ctx?: RequestContext): Promise<Resource> {
    return this.repo.create(input, ctx);
  }

  async getById(id: string, ctx?: RequestContext): Promise<Resource> {
    const resource = await this.repo.findById(id, ctx);
    if (!resource) {
      throw new NotFoundError('Resource not found');
    }
    return resource;
  }

  async list(query: ListResourcesQuery, ctx?: RequestContext): Promise<ListResponse> {
    // Decode cursor if present, inject decoded payload back into query
    let effectiveQuery = query;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor, query.sort);
      // Pass decoded payload as cursor for repository
      effectiveQuery = { ...query, cursor: decoded as unknown as string };
    }

    const result: ListResult = await this.repo.list(effectiveQuery, ctx);

    return {
      data: result.data,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    };
  }

  async update(id: string, input: UpdateResourceInput, ctx?: RequestContext): Promise<Resource> {
    const resource = await this.repo.update(id, input, ctx);
    if (!resource) {
      throw new NotFoundError('Resource not found');
    }
    return resource;
  }

  async delete(id: string, ctx?: RequestContext): Promise<void> {
    const deleted = await this.repo.delete(id, ctx);
    if (!deleted) {
      throw new NotFoundError('Resource not found');
    }
  }
}
