import { randomUUID } from 'node:crypto';

import type { Resource } from '../../src/infrastructure/db/schema.js';
import type { CreateResourceInput } from '../../src/modules/resources/schema.js';

/**
 * Shape-compatible with `CreateResourceInput` after Zod parse — includes
 * defaults so tests can hand this directly to repositories/services.
 */
export function buildCreateResourceInput(
  overrides: Partial<CreateResourceInput> = {},
): CreateResourceInput {
  return {
    name: overrides.name ?? `resource-${randomUUID().slice(0, 8)}`,
    type: overrides.type ?? 'widget',
    status: overrides.status ?? 'active',
    tags: overrides.tags ?? [],
    ownerId: overrides.ownerId ?? null,
    metadata: overrides.metadata ?? {},
  };
}

/**
 * A fully populated `Resource` row suitable for unit tests that mock the
 * repository layer.
 */
export function buildResource(overrides: Partial<Resource> = {}): Resource {
  const now = new Date();
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'resource',
    type: overrides.type ?? 'widget',
    status: overrides.status ?? 'active',
    tags: overrides.tags ?? [],
    owner_id: overrides.owner_id ?? null,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}
