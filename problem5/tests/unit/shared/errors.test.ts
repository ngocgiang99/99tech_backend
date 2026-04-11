import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import pino from 'pino';

import {
  AppError,
  BadRequestError,
  ConflictError,
  DependencyError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnprocessableEntityError,
  ValidationError,
  wrapUnknown,
} from '../../../src/shared/errors.js';
import { ERROR_CODE_META } from '../../../src/shared/error-codes.js';
import { createErrorHandler } from '../../../src/middleware/error-handler.js';

// ---------------------------------------------------------------------------
// AppError subclass assertions
// ---------------------------------------------------------------------------

describe('AppError subclasses — instanceof and code', () => {
  it('ValidationError extends AppError', () => {
    expect(new ValidationError()).toBeInstanceOf(AppError);
  });
  it('BadRequestError extends AppError', () => {
    expect(new BadRequestError()).toBeInstanceOf(AppError);
  });
  it('NotFoundError extends AppError', () => {
    expect(new NotFoundError()).toBeInstanceOf(AppError);
  });
  it('ConflictError extends AppError', () => {
    expect(new ConflictError()).toBeInstanceOf(AppError);
  });
  it('UnprocessableEntityError extends AppError', () => {
    expect(new UnprocessableEntityError()).toBeInstanceOf(AppError);
  });
  it('RateLimitError extends AppError', () => {
    expect(new RateLimitError()).toBeInstanceOf(AppError);
  });
  it('DependencyError extends AppError', () => {
    expect(new DependencyError()).toBeInstanceOf(AppError);
  });
  it('InternalError extends AppError', () => {
    expect(new InternalError()).toBeInstanceOf(AppError);
  });
});

describe('AppError subclasses — default status from ERROR_CODE_META', () => {
  it('ValidationError has status 400', () => {
    expect(new ValidationError().status).toBe(ERROR_CODE_META.VALIDATION.status);
  });
  it('BadRequestError has status 400', () => {
    expect(new BadRequestError().status).toBe(ERROR_CODE_META.BAD_REQUEST.status);
  });
  it('NotFoundError has status 404', () => {
    expect(new NotFoundError().status).toBe(ERROR_CODE_META.NOT_FOUND.status);
  });
  it('ConflictError has status 409', () => {
    expect(new ConflictError().status).toBe(ERROR_CODE_META.CONFLICT.status);
  });
  it('UnprocessableEntityError has status 422', () => {
    expect(new UnprocessableEntityError().status).toBe(ERROR_CODE_META.UNPROCESSABLE_ENTITY.status);
  });
  it('RateLimitError has status 429', () => {
    expect(new RateLimitError().status).toBe(ERROR_CODE_META.RATE_LIMIT.status);
  });
  it('DependencyError has status 503', () => {
    expect(new DependencyError().status).toBe(ERROR_CODE_META.DEPENDENCY_UNAVAILABLE.status);
  });
  it('InternalError has status 500', () => {
    expect(new InternalError().status).toBe(ERROR_CODE_META.INTERNAL_ERROR.status);
  });
});

describe('AppError subclasses — constructor overrides', () => {
  it('ValidationError accepts custom message and details', () => {
    const err = new ValidationError('bad input', [{ field: 'x', message: 'required' }]);
    expect(err.message).toBe('bad input');
    expect(err.details).toEqual([{ field: 'x', message: 'required' }]);
    expect(err.code).toBe('VALIDATION');
  });

  it('ValidationError uses default message when none supplied', () => {
    expect(new ValidationError().message).toBe(ERROR_CODE_META.VALIDATION.defaultMessage);
  });

  it('NotFoundError accepts custom message', () => {
    const err = new NotFoundError('Resource not found');
    expect(err.message).toBe('Resource not found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('ConflictError accepts custom message', () => {
    const err = new ConflictError('duplicate');
    expect(err.message).toBe('duplicate');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('DependencyError accepts a cause', () => {
    const cause = new Error('connection refused');
    const err = new DependencyError(undefined, { cause });
    expect(err.cause).toBe(cause);
    expect(err.status).toBe(503);
  });

  it('InternalError uses generic message by default', () => {
    expect(new InternalError().message).toBe(ERROR_CODE_META.INTERNAL_ERROR.defaultMessage);
  });
});

describe('Symbol.toStringTag', () => {
  it('ValidationError has correct toStringTag', () => {
    expect(new ValidationError()[Symbol.toStringTag]).toBe('ValidationError');
  });
  it('NotFoundError has correct toStringTag', () => {
    expect(new NotFoundError()[Symbol.toStringTag]).toBe('NotFoundError');
  });
  it('InternalError has correct toStringTag', () => {
    expect(new InternalError()[Symbol.toStringTag]).toBe('InternalError');
  });
  it('DependencyError has correct toStringTag', () => {
    expect(new DependencyError()[Symbol.toStringTag]).toBe('DependencyError');
  });
});

describe('wrapUnknown', () => {
  it('wraps a plain Error in InternalError with cause set', () => {
    const original = new Error('boom');
    const wrapped = wrapUnknown(original);
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.status).toBe(500);
    expect(wrapped.code).toBe('INTERNAL_ERROR');
  });

  it('is a pass-through for an existing AppError (===)', () => {
    const err = new ValidationError('bad');
    const result = wrapUnknown(err);
    expect(result).toBe(err);
  });

  it('is a pass-through for any AppError subclass', () => {
    const err = new NotFoundError('gone');
    expect(wrapUnknown(err)).toBe(err);
  });

  it('wraps a thrown string in InternalError', () => {
    const wrapped = wrapUnknown('something went wrong');
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.cause).toBe('something went wrong');
  });

  it('wraps a plain object in InternalError', () => {
    const obj = { detail: 'unexpected' };
    const wrapped = wrapUnknown(obj);
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.cause).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// createErrorHandler (legacy regression suite — must continue to pass)
// ---------------------------------------------------------------------------

function buildMockRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  } as unknown as Response;
  return res;
}

function buildMockReq(): Request {
  return {
    id: 'req-123',
    method: 'GET',
    url: '/x',
  } as unknown as Request;
}

const silentLogger = pino({ level: 'silent' });

describe('createErrorHandler', () => {
  it('serializes AppError into the spec error shape', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new ValidationError('bad', [{ field: 'a' }]), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION',
        message: 'bad',
        requestId: 'req-123',
        details: [{ field: 'a' }],
      },
    });
  });

  it('omits details when the error has none', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new NotFoundError('gone'), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(call.error).not.toHaveProperty('details');
    expect(call.error['code']).toBe('NOT_FOUND');
  });

  it('translates body-parser entity.too.large to 400 VALIDATION', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const err = Object.assign(new Error('too big'), { type: 'entity.too.large' });
    handler(err, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('Request body too large');
  });

  it('translates body-parser entity.parse.failed to 400 VALIDATION', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const err = Object.assign(new Error('parse'), { type: 'entity.parse.failed' });
    handler(err, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('Request body is not valid JSON');
  });

  it('falls through to 500 INTERNAL_ERROR for unknown errors', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new Error('kaboom'), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.requestId).toBe('req-123');
  });
});
