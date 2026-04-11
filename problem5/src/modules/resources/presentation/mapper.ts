import type { Resource } from '../../../infrastructure/db/schema.js';

export function toDto(resource: Resource) {
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
