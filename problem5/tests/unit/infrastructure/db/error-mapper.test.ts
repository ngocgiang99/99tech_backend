import { describe, expect, it } from 'vitest';

import { mapDbError } from '../../../../src/infrastructure/db/error-mapper.js';
import {
  AppError,
  ConflictError,
  DependencyError,
  InternalError,
  ValidationError,
} from '../../../../src/shared/errors.js';

/** Build a synthetic pg-shaped error without importing pg directly. */
function makePgError(code: string, extra?: Record<string, unknown>) {
  return {
    name: 'error',
    code,
    message: `pg error with code ${code}`,
    ...extra,
  };
}

describe('mapDbError', () => {
  describe('unique violation (23505)', () => {
    it('maps to ConflictError with CONFLICT code and status 409', () => {
      const result = mapDbError(makePgError('23505', { detail: 'Key (name)=(foo) already exists.' }));
      expect(result).toBeInstanceOf(ConflictError);
      expect(result).toBeInstanceOf(AppError);
      expect(result.code).toBe('CONFLICT');
      expect(result.status).toBe(409);
    });

    it('attaches original error as cause', () => {
      const pgErr = makePgError('23505');
      const result = mapDbError(pgErr);
      expect(result.cause).toBe(pgErr);
    });
  });

  describe('not-null violation (23502)', () => {
    it('maps to ValidationError with status 400', () => {
      const result = mapDbError(makePgError('23502', { column: 'owner_id' }));
      expect(result).toBeInstanceOf(ValidationError);
      expect(result.status).toBe(400);
    });

    it('includes column name in details when available', () => {
      const result = mapDbError(makePgError('23502', { column: 'owner_id' }));
      expect(result.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'owner_id' }),
        ]),
      );
    });

    it('handles missing column gracefully (no details)', () => {
      const result = mapDbError(makePgError('23502'));
      expect(result).toBeInstanceOf(ValidationError);
      expect(result.details).toBeUndefined();
    });
  });

  describe('foreign key violation (23503)', () => {
    it('maps to ValidationError with status 400', () => {
      const result = mapDbError(makePgError('23503'));
      expect(result).toBeInstanceOf(ValidationError);
      expect(result.status).toBe(400);
    });
  });

  describe('string data right truncation (22001)', () => {
    it('maps to ValidationError with status 400', () => {
      const result = mapDbError(makePgError('22001'));
      expect(result).toBeInstanceOf(ValidationError);
      expect(result.status).toBe(400);
    });
  });

  describe('deadlock (40P01)', () => {
    it('maps to DependencyError with DEPENDENCY_UNAVAILABLE code and status 503', () => {
      const result = mapDbError(makePgError('40P01'));
      expect(result).toBeInstanceOf(DependencyError);
      expect(result.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(result.status).toBe(503);
    });
  });

  describe('query canceled / timeout (57014)', () => {
    it('maps to DependencyError with status 503', () => {
      const result = mapDbError(makePgError('57014'));
      expect(result).toBeInstanceOf(DependencyError);
      expect(result.status).toBe(503);
    });
  });

  describe('too many connections (53300)', () => {
    it('maps to DependencyError with status 503', () => {
      const result = mapDbError(makePgError('53300'));
      expect(result).toBeInstanceOf(DependencyError);
      expect(result.status).toBe(503);
    });
  });

  describe('unknown pg code (XX000)', () => {
    it('maps to InternalError with INTERNAL_ERROR code and status 500', () => {
      const result = mapDbError(makePgError('XX000'));
      expect(result).toBeInstanceOf(InternalError);
      expect(result.code).toBe('INTERNAL_ERROR');
      expect(result.status).toBe(500);
    });

    it('attaches original error as cause', () => {
      const pgErr = makePgError('XX000');
      const result = mapDbError(pgErr);
      expect(result.cause).toBe(pgErr);
    });

    it('exposes raw pg code via non-enumerable pgCode property', () => {
      const result = mapDbError(makePgError('XX000'));
      expect((result as AppError & { pgCode?: string }).pgCode).toBe('XX000');
      const descriptor = Object.getOwnPropertyDescriptor(result, 'pgCode');
      expect(descriptor?.enumerable).toBe(false);
    });
  });

  describe('non-pg error (a plain string)', () => {
    it('maps to InternalError', () => {
      const result = mapDbError('something went wrong');
      expect(result).toBeInstanceOf(InternalError);
      expect(result.status).toBe(500);
    });
  });

  describe('non-pg Error object (no code field)', () => {
    it('maps to InternalError with original as cause', () => {
      const err = new Error('network error');
      const result = mapDbError(err);
      expect(result).toBeInstanceOf(InternalError);
      expect(result.cause).toBe(err);
    });
  });

  describe('pgCode non-enumerable property on all mapped errors', () => {
    it('is present and non-enumerable on ConflictError (23505)', () => {
      const result = mapDbError(makePgError('23505'));
      expect((result as AppError & { pgCode?: string }).pgCode).toBe('23505');
      const descriptor = Object.getOwnPropertyDescriptor(result, 'pgCode');
      expect(descriptor?.enumerable).toBe(false);
    });

    it('is present and non-enumerable on DependencyError (40P01)', () => {
      const result = mapDbError(makePgError('40P01'));
      expect((result as AppError & { pgCode?: string }).pgCode).toBe('40P01');
      const descriptor = Object.getOwnPropertyDescriptor(result, 'pgCode');
      expect(descriptor?.enumerable).toBe(false);
    });

    it('does NOT appear in JSON.stringify output', () => {
      const result = mapDbError(makePgError('23505'));
      const json = JSON.stringify(result);
      expect(json).not.toContain('pgCode');
    });
  });
});
