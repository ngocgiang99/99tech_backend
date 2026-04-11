import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_CODE_META,
  errorStatusFor,
  defaultMessageFor,
} from '../../../src/shared/error-codes.js';

describe('ERROR_CODES', () => {
  it('every code in the tuple has a corresponding ERROR_CODE_META entry', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_META).toHaveProperty(code);
    }
  });

  it('ERROR_CODE_META has no extra keys beyond the tuple', () => {
    const metaKeys = Object.keys(ERROR_CODE_META).sort();
    const tupleKeys = [...ERROR_CODES].sort();
    expect(metaKeys).toEqual(tupleKeys);
  });

  it('all statuses are in the expected HTTP range (400-599)', () => {
    for (const code of ERROR_CODES) {
      const { status } = ERROR_CODE_META[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
    }
  });

  it('4xx codes have status 400-499', () => {
    const fourHundred: string[] = ['VALIDATION', 'BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'UNPROCESSABLE_ENTITY', 'RATE_LIMIT'];
    for (const code of fourHundred) {
      const meta = ERROR_CODE_META[code as (typeof ERROR_CODES)[number]];
      expect(meta.status).toBeGreaterThanOrEqual(400);
      expect(meta.status).toBeLessThanOrEqual(499);
    }
  });

  it('DEPENDENCY_UNAVAILABLE has status 503', () => {
    expect(ERROR_CODE_META.DEPENDENCY_UNAVAILABLE.status).toBe(503);
  });

  it('INTERNAL_ERROR has status 500', () => {
    expect(ERROR_CODE_META.INTERNAL_ERROR.status).toBe(500);
  });
});

describe('errorStatusFor', () => {
  it('returns correct status for VALIDATION', () => {
    expect(errorStatusFor('VALIDATION')).toBe(400);
  });

  it('returns correct status for NOT_FOUND', () => {
    expect(errorStatusFor('NOT_FOUND')).toBe(404);
  });

  it('returns correct status for INTERNAL_ERROR', () => {
    expect(errorStatusFor('INTERNAL_ERROR')).toBe(500);
  });

  it('returns correct status for DEPENDENCY_UNAVAILABLE', () => {
    expect(errorStatusFor('DEPENDENCY_UNAVAILABLE')).toBe(503);
  });

  it('returns correct status for RATE_LIMIT', () => {
    expect(errorStatusFor('RATE_LIMIT')).toBe(429);
  });
});

describe('defaultMessageFor', () => {
  it('returns correct message for VALIDATION', () => {
    expect(defaultMessageFor('VALIDATION')).toBe('Request validation failed');
  });

  it('returns correct message for NOT_FOUND', () => {
    expect(defaultMessageFor('NOT_FOUND')).toBe('Resource not found');
  });

  it('returns correct message for INTERNAL_ERROR', () => {
    expect(defaultMessageFor('INTERNAL_ERROR')).toBe('Internal server error');
  });

  it('returns correct message for DEPENDENCY_UNAVAILABLE', () => {
    expect(defaultMessageFor('DEPENDENCY_UNAVAILABLE')).toBe(
      'Upstream dependency is temporarily unavailable',
    );
  });

  it('returns non-empty strings for all codes', () => {
    for (const code of ERROR_CODES) {
      expect(defaultMessageFor(code).length).toBeGreaterThan(0);
    }
  });
});
