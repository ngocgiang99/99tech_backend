import { NotFoundError } from '../../lib/errors.js';
import type { Resource } from '../../db/schema.js';

import type { ResourceRepository, ListResult } from './repository.js';
import type { CreateResourceInput, UpdateResourceInput, ListResourcesQuery } from './schema.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export interface ListResponse {
  data: Resource[];
  nextCursor: string | null;
}

export class ResourceService {
  constructor(private readonly repo: ResourceRepository) {}

  async create(input: CreateResourceInput): Promise<Resource> {
    return this.repo.create(input);
  }

  async getById(id: string): Promise<Resource> {
    const resource = await this.repo.findById(id);
    if (!resource) {
      throw new NotFoundError('Resource not found');
    }
    return resource;
  }

  async list(query: ListResourcesQuery): Promise<ListResponse> {
    // Decode cursor if present, inject decoded payload back into query
    let effectiveQuery = query;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor, query.sort);
      // Pass decoded payload as cursor for repository
      effectiveQuery = { ...query, cursor: decoded as unknown as string };
    }

    const result: ListResult = await this.repo.list(effectiveQuery);

    return {
      data: result.data,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    };
  }

  async update(id: string, input: UpdateResourceInput): Promise<Resource> {
    const resource = await this.repo.update(id, input);
    if (!resource) {
      throw new NotFoundError('Resource not found');
    }
    return resource;
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.repo.delete(id);
    if (!deleted) {
      throw new NotFoundError('Resource not found');
    }
  }
}
