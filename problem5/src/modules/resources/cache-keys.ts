import { createHash } from 'node:crypto';

import type { ListResourcesQuery } from './schema.js';

const KEY_VERSION = 'v1';
const DETAIL_PREFIX = `resource:${KEY_VERSION}:id`;
const LIST_PREFIX = `resource:${KEY_VERSION}:list`;

export function detailKey(id: string): string {
  return `${DETAIL_PREFIX}:${id}`;
}

export function listVersionKey(prefix: string): string {
  return prefix;
}

export function listKey(
  filters: ListResourcesQuery,
  version: number | string,
): string {
  const normalized = normalizeFilters(filters);
  const hash = sha256Hex16(normalized);
  return `${LIST_PREFIX}:${version}:${hash}`;
}

/**
 * Canonical JSON serialization of list filters.
 *
 * Guarantees:
 *   - Keys appear in sorted order
 *   - Array values are sorted lexicographically (so ?status=a&status=b and
 *     ?status=b&status=a yield the same hash)
 *   - Undefined keys are omitted
 */
export function normalizeFilters(filters: ListResourcesQuery): string {
  const entries: [string, unknown][] = [];

  if (filters.type !== undefined) entries.push(['type', filters.type]);
  if (filters.status !== undefined && filters.status.length > 0) {
    entries.push(['status', [...filters.status].sort()]);
  }
  if (filters.tag !== undefined && filters.tag.length > 0) {
    entries.push(['tag', [...filters.tag].sort()]);
  }
  if (filters.ownerId !== undefined) entries.push(['ownerId', filters.ownerId]);
  if (filters.createdAfter !== undefined) entries.push(['createdAfter', filters.createdAfter]);
  if (filters.createdBefore !== undefined) entries.push(['createdBefore', filters.createdBefore]);
  entries.push(['limit', filters.limit]);
  entries.push(['sort', filters.sort]);
  if (filters.cursor !== undefined) entries.push(['cursor', filters.cursor]);

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const obj: Record<string, unknown> = {};
  for (const [k, v] of entries) obj[k] = v;

  return JSON.stringify(obj);
}

export function sha256Hex16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
