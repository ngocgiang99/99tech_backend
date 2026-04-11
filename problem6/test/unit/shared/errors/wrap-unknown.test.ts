import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { z, ZodError } from 'zod';

import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import {
  BadRequestError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  UnprocessableEntityError,
  ValidationError,
} from '../../../../src/scoreboard/shared/errors/domain-error';
import { wrapUnknown } from '../../../../src/scoreboard/shared/errors/wrap-unknown';

describe('wrapUnknown', () => {
  it('passes DomainError through unchanged (same reference)', () => {
    const err = new ValidationError('bad');
    expect(wrapUnknown(err)).toBe(err);
  });

  it('wraps InvalidArgumentError (domain layer) as ValidationError', () => {
    const err = new InvalidArgumentError('delta must be positive');
    const wrapped = wrapUnknown(err);
    expect(wrapped).toBeInstanceOf(ValidationError);
    expect(wrapped.message).toBe('delta must be positive');
  });

  it('wraps ZodError as ValidationError with issues as details', () => {
    const schema = z.object({ name: z.string().min(1) });
    let zodErr: ZodError | undefined;
    try {
      schema.parse({ name: '' });
    } catch (e) {
      zodErr = e as ZodError;
    }
    const wrapped = wrapUnknown(zodErr!);
    expect(wrapped).toBeInstanceOf(ValidationError);
    expect(Array.isArray(wrapped.details)).toBe(true);
    expect(typeof wrapped.message).toBe('string');
  });

  it('routes pg-shaped errors through mapDbError (23505 → ConflictError)', () => {
    const pgErr = { code: '23505', name: 'error', message: 'dup' };
    const wrapped = wrapUnknown(pgErr);
    expect(wrapped).toBeInstanceOf(ConflictError);
  });

  it('wraps Redis MaxRetriesPerRequestError as DependencyUnavailableError', () => {
    const err = new Error('Reached the max retries per request limit');
    err.name = 'MaxRetriesPerRequestError';
    const wrapped = wrapUnknown(err);
    expect(wrapped).toBeInstanceOf(DependencyUnavailableError);
    expect(wrapped.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(wrapped.cause).toBe(err);
  });

  it('wraps ECONNREFUSED Error as DependencyUnavailableError', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    const wrapped = wrapUnknown(err);
    expect(wrapped).toBeInstanceOf(DependencyUnavailableError);
  });

  it('maps NestJS ForbiddenException → ForbiddenError', () => {
    const err = new ForbiddenException('scope mismatch');
    const wrapped = wrapUnknown(err);
    expect(wrapped).toBeInstanceOf(ForbiddenError);
    expect(wrapped.code).toBe('FORBIDDEN');
    expect(wrapped.message).toContain('scope mismatch');
  });

  it('maps NestJS UnauthorizedException → UnauthenticatedError', () => {
    const wrapped = wrapUnknown(new UnauthorizedException('no token'));
    expect(wrapped).toBeInstanceOf(UnauthenticatedError);
  });

  it('maps NestJS NotFoundException → NotFoundError', () => {
    const wrapped = wrapUnknown(new NotFoundException('missing'));
    expect(wrapped).toBeInstanceOf(NotFoundError);
  });

  it('maps NestJS BadRequestException → BadRequestError', () => {
    const wrapped = wrapUnknown(new BadRequestException('bad'));
    expect(wrapped).toBeInstanceOf(BadRequestError);
  });

  it('maps NestJS ServiceUnavailableException → DependencyUnavailableError', () => {
    const wrapped = wrapUnknown(new ServiceUnavailableException('down'));
    expect(wrapped).toBeInstanceOf(DependencyUnavailableError);
  });

  it('maps 409 HttpException → ConflictError', () => {
    const wrapped = wrapUnknown(new HttpException('dup', 409));
    expect(wrapped).toBeInstanceOf(ConflictError);
  });

  it('maps 422 HttpException → UnprocessableEntityError', () => {
    const wrapped = wrapUnknown(new HttpException('unprocessable', 422));
    expect(wrapped).toBeInstanceOf(UnprocessableEntityError);
  });

  it('maps 429 HttpException → RateLimitError', () => {
    const wrapped = wrapUnknown(new HttpException('too many', 429));
    expect(wrapped).toBeInstanceOf(RateLimitError);
  });

  it('maps 5xx HttpException → InternalError', () => {
    const wrapped = wrapUnknown(new InternalServerErrorException('boom'));
    expect(wrapped).toBeInstanceOf(InternalError);
  });

  it('maps arbitrary 5xx HttpException (502) → InternalError', () => {
    const wrapped = wrapUnknown(new HttpException('bad gateway', 502));
    expect(wrapped).toBeInstanceOf(InternalError);
  });

  it('maps other 4xx HttpException → BadRequestError', () => {
    const err = new HttpException('teapot', 418);
    const wrapped = wrapUnknown(err);
    expect(wrapped.code).toBe('BAD_REQUEST');
  });

  it('wraps a generic Error as InternalError with cause', () => {
    const err = new Error('boom');
    const wrapped = wrapUnknown(err);
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.cause).toBe(err);
  });

  it('wraps a non-Error thrown value as InternalError with cause', () => {
    const wrapped = wrapUnknown('weird');
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.cause).toBe('weird');
  });

  it('wraps null as InternalError', () => {
    const wrapped = wrapUnknown(null);
    expect(wrapped).toBeInstanceOf(InternalError);
  });
});
