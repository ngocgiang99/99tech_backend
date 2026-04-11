import { HttpException } from '@nestjs/common';

import {
  BadRequestError,
  ConflictError,
  DependencyUnavailableError,
  DomainError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  UnprocessableEntityError,
  ValidationError,
} from '../../../../src/scoreboard/shared/errors/domain-error';
import { ERROR_CODE_META } from '../../../../src/scoreboard/shared/errors/error-codes';

type Ctor = new (message?: string) => DomainError;

const cases: Array<{
  name: string;
  ctor: Ctor;
  code: keyof typeof ERROR_CODE_META;
}> = [
  { name: 'ValidationError', ctor: ValidationError, code: 'VALIDATION' },
  { name: 'BadRequestError', ctor: BadRequestError, code: 'BAD_REQUEST' },
  {
    name: 'UnauthenticatedError',
    ctor: UnauthenticatedError,
    code: 'UNAUTHENTICATED',
  },
  { name: 'ForbiddenError', ctor: ForbiddenError, code: 'FORBIDDEN' },
  { name: 'NotFoundError', ctor: NotFoundError, code: 'NOT_FOUND' },
  { name: 'ConflictError', ctor: ConflictError, code: 'CONFLICT' },
  {
    name: 'UnprocessableEntityError',
    ctor: UnprocessableEntityError,
    code: 'UNPROCESSABLE_ENTITY',
  },
  { name: 'RateLimitError', ctor: RateLimitError, code: 'RATE_LIMIT' },
  {
    name: 'DependencyUnavailableError',
    ctor: DependencyUnavailableError,
    code: 'TEMPORARILY_UNAVAILABLE',
  },
  { name: 'InternalError', ctor: InternalError, code: 'INTERNAL_ERROR' },
];

describe('DomainError hierarchy', () => {
  for (const { name, ctor, code } of cases) {
    describe(name, () => {
      it('sets code, status, and default message', () => {
        const err = new ctor();
        expect(err.code).toBe(code);
        expect(err.getStatus()).toBe(ERROR_CODE_META[code].status);
        expect(err.message).toBe(ERROR_CODE_META[code].defaultMessage);
      });

      it('is instanceof HttpException and DomainError and the subclass', () => {
        const err = new ctor();
        expect(err).toBeInstanceOf(HttpException);
        expect(err).toBeInstanceOf(DomainError);
        expect(err).toBeInstanceOf(ctor);
      });

      it('sets this.name to the constructor name', () => {
        const err = new ctor();
        expect(err.name).toBe(name);
      });

      it('accepts a custom message', () => {
        const err = new ctor('custom message');
        expect(err.message).toBe('custom message');
      });
    });
  }

  describe('ValidationError details payload', () => {
    it('stores details when provided', () => {
      const err = new ValidationError('delta out of range', {
        field: 'delta',
        max: 100,
      });
      expect(err.code).toBe('VALIDATION');
      expect(err.getStatus()).toBe(400);
      expect(err.details).toEqual({ field: 'delta', max: 100 });
    });

    it('has undefined details when omitted', () => {
      const err = new ValidationError('bad');
      expect(err.details).toBeUndefined();
    });
  });

  describe('cause chain', () => {
    it('preserves cause on DependencyUnavailableError', () => {
      const inner = new Error('socket closed');
      const err = new DependencyUnavailableError('redis read failed', {
        cause: inner,
      });
      expect(err.cause).toBe(inner);
      expect((err.cause as Error).message).toBe('socket closed');
    });

    it('preserves cause on InternalError', () => {
      const inner = new Error('underlying');
      const err = new InternalError('wrapper', { cause: inner });
      expect(err.cause).toBe(inner);
    });
  });
});
