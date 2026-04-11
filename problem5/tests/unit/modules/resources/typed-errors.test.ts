/**
 * Typed-error assertions for the resources module (task 8.4).
 *
 * Every error thrown from the service layer MUST be an `instanceof AppError`.
 * This test builds a stub repository and verifies that all service-level
 * error paths produce typed AppError subclasses, not bare Error objects.
 */

import { describe, expect, it } from 'vitest';

import { AppError, NotFoundError } from '../../../../src/shared/errors.js';
import { ResourceService } from '../../../../src/modules/resources/application/service.js';
import type { ResourceRepository } from '../../../../src/modules/resources/infrastructure/repository.js';

/** Minimal stub that resolves/rejects predictably. */
function makeRepo(overrides: Partial<ResourceRepository> = {}): ResourceRepository {
  return {
    create: async () => { throw new Error('stub: not set up'); },
    findById: async () => null,
    list: async () => ({ data: [], nextCursor: null }),
    update: async () => null,
    delete: async () => false,
    ...overrides,
  };
}

describe('ResourceService — all thrown errors are instanceof AppError', () => {
  describe('getById', () => {
    it('throws NotFoundError (instanceof AppError) when resource is missing', async () => {
      const service = new ResourceService(makeRepo({ findById: async () => null }));
      const err = await service.getById('11111111-1111-1111-1111-111111111111').catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as AppError).code).toBe('NOT_FOUND');
      expect((err as AppError).status).toBe(404);
    });
  });

  describe('update', () => {
    it('throws NotFoundError (instanceof AppError) when resource is missing', async () => {
      const service = new ResourceService(makeRepo({ update: async () => null }));
      const err = await service
        .update('11111111-1111-1111-1111-111111111111', { name: 'new-name' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as AppError).status).toBe(404);
    });
  });

  describe('delete', () => {
    it('throws NotFoundError (instanceof AppError) when resource is missing', async () => {
      const service = new ResourceService(makeRepo({ delete: async () => false }));
      const err = await service
        .delete('11111111-1111-1111-1111-111111111111')
        .catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as AppError).status).toBe(404);
    });
  });

  describe('when the repository itself throws a typed AppError', () => {
    it('propagates ConflictError from create without re-wrapping', async () => {
      const { ConflictError } = await import('../../../../src/shared/errors.js');
      const repo = makeRepo({
        create: async () => { throw new ConflictError(); },
      });
      const service = new ResourceService(repo);
      const err = await service
        .create({ name: 'x', type: 'server' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as AppError).code).toBe('CONFLICT');
    });
  });

  describe('service never swallows errors from the repository', () => {
    it('getById propagates InternalError from repo', async () => {
      const { InternalError } = await import('../../../../src/shared/errors.js');
      const repo = makeRepo({
        findById: async () => { throw new InternalError(); },
      });
      const service = new ResourceService(repo);
      const err = await service
        .getById('11111111-1111-1111-1111-111111111111')
        .catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INTERNAL_ERROR');
    });
  });
});
