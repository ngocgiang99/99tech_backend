import { NotFoundError } from '../../../shared/errors.js';
import type { Resource } from '../../../infrastructure/db/schema.js';
import type { ResourceRepository } from '../infrastructure/repository.js';
import type { CreateResourceInput, UpdateResourceInput, ListResourcesQuery } from '../schema.js';

import type { RequestContext } from './request-context.js';

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
    // Pass-through. The raw repository decodes the cursor on entry and
    // encodes `nextCursor` on exit, so the service — and every layer
    // above it — speaks only the opaque base64url string form.
    return this.repo.list(query, ctx);
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
