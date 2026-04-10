import { describe, expect, it } from 'vitest';

import {
  CreateResourceSchema,
  UpdateResourceSchema,
  ListResourcesQuerySchema,
} from '../../../../src/modules/resources/schema.js';

describe('CreateResourceSchema', () => {
  it('accepts a minimal valid body with sensible defaults', () => {
    const result = CreateResourceSchema.safeParse({ name: 'foo', type: 'widget' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('active');
      expect(result.data.tags).toEqual([]);
      expect(result.data.metadata).toEqual({});
      expect(result.data.ownerId).toBeNull();
    }
  });

  it('rejects unknown fields (.strict())', () => {
    const result = CreateResourceSchema.safeParse({
      name: 'foo',
      type: 'widget',
      unknownField: 'boom',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name longer than 200 characters', () => {
    const result = CreateResourceSchema.safeParse({
      name: 'x'.repeat(201),
      type: 'widget',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = CreateResourceSchema.safeParse({ name: '', type: 'widget' });
    expect(result.success).toBe(false);
  });

  it('rejects metadata larger than 16 KB', () => {
    const bigString = 'a'.repeat(17_000);
    const result = CreateResourceSchema.safeParse({
      name: 'foo',
      type: 'widget',
      metadata: { payload: bigString },
    });
    expect(result.success).toBe(false);
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    const result = CreateResourceSchema.safeParse({ name: 'foo', type: 'widget', tags });
    expect(result.success).toBe(false);
  });
});

describe('UpdateResourceSchema', () => {
  it('accepts a partial update', () => {
    const result = UpdateResourceSchema.safeParse({ status: 'archived' });
    expect(result.success).toBe(true);
  });

  it('rejects id in the body (server-controlled)', () => {
    const result = UpdateResourceSchema.safeParse({ id: 'anything' });
    expect(result.success).toBe(false);
  });

  it('rejects createdAt in the body (server-controlled)', () => {
    const result = UpdateResourceSchema.safeParse({ createdAt: '2026-01-01T00:00:00Z' });
    expect(result.success).toBe(false);
  });

  it('rejects updatedAt in the body (server-controlled)', () => {
    const result = UpdateResourceSchema.safeParse({ updatedAt: '2026-01-01T00:00:00Z' });
    expect(result.success).toBe(false);
  });

  it('accepts explicit null ownerId', () => {
    const result = UpdateResourceSchema.safeParse({ ownerId: null });
    expect(result.success).toBe(true);
  });
});

describe('ListResourcesQuerySchema', () => {
  it('applies the default limit of 20', () => {
    const result = ListResourcesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.sort).toBe('-createdAt');
    }
  });

  it('rejects limit > 100', () => {
    const result = ListResourcesQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects limit < 1', () => {
    const result = ListResourcesQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('coerces string limit to number', () => {
    const result = ListResourcesQuerySchema.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(25);
  });

  it('normalizes status to array (single value)', () => {
    const result = ListResourcesQuerySchema.safeParse({ status: 'active' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toEqual(['active']);
  });

  it('normalizes status to array (multiple values)', () => {
    const result = ListResourcesQuerySchema.safeParse({ status: ['active', 'pending'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toEqual(['active', 'pending']);
  });

  it('rejects invalid sort value', () => {
    const result = ListResourcesQuerySchema.safeParse({ sort: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid ownerId (non-UUID)', () => {
    const result = ListResourcesQuerySchema.safeParse({ ownerId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid createdAfter (non-ISO)', () => {
    const result = ListResourcesQuerySchema.safeParse({ createdAfter: 'yesterday' });
    expect(result.success).toBe(false);
  });
});
