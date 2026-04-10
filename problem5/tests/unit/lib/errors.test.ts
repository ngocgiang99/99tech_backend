import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import pino from 'pino';

import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../src/lib/errors.js';
import { createErrorHandler } from '../../../src/middleware/error-handler.js';

describe('AppError subclasses', () => {
  it('ValidationError maps to 400 + VALIDATION code', () => {
    const err = new ValidationError('bad input', [{ field: 'x', message: 'required' }]);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION');
    expect(err.details).toEqual([{ field: 'x', message: 'required' }]);
  });

  it('NotFoundError maps to 404 + NOT_FOUND code', () => {
    const err = new NotFoundError('Resource not found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('ConflictError maps to 409 + CONFLICT code', () => {
    const err = new ConflictError('duplicate');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('preserves the original message', () => {
    const err = new ValidationError('custom');
    expect(err.message).toBe('custom');
  });
});

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
    expect(body.error.message).toBe('Internal Server Error');
    expect(body.error.requestId).toBe('req-123');
  });
});
