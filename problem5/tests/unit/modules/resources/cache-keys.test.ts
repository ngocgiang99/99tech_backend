import { describe, expect, it } from 'vitest';

import {
  detailKey,
  listKey,
  listVersionKey,
  normalizeFilters,
  sha256Hex16,
} from '../../../../src/modules/resources/cache-keys.js';
import type { ListResourcesQuery } from '../../../../src/modules/resources/schema.js';

function buildFilters(overrides: Partial<ListResourcesQuery> = {}): ListResourcesQuery {
  return {
    limit: 20,
    sort: '-createdAt',
    ...overrides,
  } as ListResourcesQuery;
}

describe('detailKey', () => {
  it('has the expected shape and is within the 64-byte bound', () => {
    const key = detailKey('11111111-1111-1111-1111-111111111111');
    expect(key).toBe('resource:v1:id:11111111-1111-1111-1111-111111111111');
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(64);
  });
});

describe('listVersionKey', () => {
  it('returns the configured prefix unchanged', () => {
    expect(listVersionKey('resource:list:version')).toBe('resource:list:version');
  });
});

describe('normalizeFilters', () => {
  it('sorts keys alphabetically', () => {
    const normalized = normalizeFilters(
      buildFilters({ type: 'widget', status: ['active'] }),
    );
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('sorts array values deterministically', () => {
    const a = normalizeFilters(buildFilters({ status: ['b', 'a', 'c'] }));
    const b = normalizeFilters(buildFilters({ status: ['c', 'a', 'b'] }));
    expect(a).toBe(b);
  });

  it('omits undefined filter keys', () => {
    const normalized = normalizeFilters(buildFilters({}));
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('type');
    expect(parsed).not.toHaveProperty('ownerId');
  });
});

describe('listKey', () => {
  it('produces the same key for equivalent-but-reordered filters', () => {
    const a = listKey(
      buildFilters({ type: 'widget', status: ['active', 'pending'] }),
      1,
    );
    const b = listKey(
      buildFilters({ status: ['pending', 'active'], type: 'widget' }),
      1,
    );
    expect(a).toBe(b);
  });

  it('produces different keys when the list version changes', () => {
    const filters = buildFilters({ type: 'widget' });
    expect(listKey(filters, 1)).not.toBe(listKey(filters, 2));
  });

  it('produces different keys for different filter tuples', () => {
    const a = listKey(buildFilters({ type: 'widget' }), 1);
    const b = listKey(buildFilters({ type: 'gadget' }), 1);
    expect(a).not.toBe(b);
  });

  it('stays bounded in length regardless of filter count', () => {
    const dense = buildFilters({
      type: 'widget',
      status: Array.from({ length: 50 }, (_, i) => `status-${i}`),
      tag: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
      ownerId: '11111111-1111-1111-1111-111111111111',
      createdAfter: '2020-01-01T00:00:00Z',
      createdBefore: '2030-01-01T00:00:00Z',
    });
    const key = listKey(dense, 999);
    // Hash is 32 hex chars + fixed prefix; total should fit comfortably under 80.
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(80);
  });

  it('uses a 32-char SHA-256 suffix', () => {
    const key = listKey(buildFilters({ type: 'widget' }), 1);
    const suffix = key.split(':').at(-1) ?? '';
    expect(suffix).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('sha256Hex16', () => {
  it('returns 32 hex characters (16 bytes)', () => {
    expect(sha256Hex16('hello').length).toBe(32);
    expect(sha256Hex16('hello')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex16('xyz')).toBe(sha256Hex16('xyz'));
  });
});
