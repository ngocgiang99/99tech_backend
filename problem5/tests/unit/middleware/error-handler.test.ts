import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import pino from 'pino';

import { createErrorHandler } from '../../../src/middleware/error-handler.js';
import {
  AppError,
  ConflictError,
  DependencyError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors.js';
import { MetricsRegistry } from '../../../src/observability/metrics-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });

function buildMockRes(): Response {
  const res = {
    headersSent: false,
    status: vi.fn(function (this: Response) {
      return this;
    }),
    json: vi.fn(function (this: Response) {
      return this;
    }),
  } as unknown as Response;
  return res;
}

function buildMockReq(overrides: Partial<Record<string, unknown>> = {}): Request {
  return {
    id: 'req-test-123',
    method: 'GET',
    url: '/api/v1/resources/abc',
    ip: '127.0.0.1',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// Known AppError subclasses
// ---------------------------------------------------------------------------

describe('createErrorHandler — known AppError', () => {
  it('handles ValidationError → 400 VALIDATION with details', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const err = new ValidationError('bad input', [
      { path: 'name', code: 'required', message: 'Name is required' },
    ]);
    handler(err, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('VALIDATION');
    expect(body.error['message']).toBe('bad input');
    expect(body.error['requestId']).toBe('req-test-123');
    expect(body.error['details']).toEqual([
      { path: 'name', code: 'required', message: 'Name is required' },
    ]);
    expect(body.error).not.toHaveProperty('errorId');
  });

  it('handles NotFoundError → 404 NOT_FOUND, no details, no errorId', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new NotFoundError('gone'), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('NOT_FOUND');
    expect(body.error).not.toHaveProperty('details');
    expect(body.error).not.toHaveProperty('errorId');
  });

  it('handles ConflictError → 409 CONFLICT', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new ConflictError('duplicate'), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('CONFLICT');
  });

  it('handles DependencyError → 503 with errorId', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new DependencyError(), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('DEPENDENCY_UNAVAILABLE');
    expect(typeof body.error['errorId']).toBe('string');
  });

  it('handles InternalError → 500, generic message, errorId present', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new InternalError('do not leak this'), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('INTERNAL_ERROR');
    expect(body.error['message']).toBe('Internal server error');
    expect(typeof body.error['errorId']).toBe('string');
    expect(body.error['message']).not.toContain('do not leak this');
  });
});

// ---------------------------------------------------------------------------
// Unknown Error (wrapped in InternalError)
// ---------------------------------------------------------------------------

describe('createErrorHandler — unknown Error', () => {
  it('wraps plain Error in InternalError → 500 with generic message', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new Error('kaboom'), buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('INTERNAL_ERROR');
    expect(body.error['message']).toBe('Internal server error');
    expect(body.error).not.toHaveProperty('details');
    expect(typeof body.error['errorId']).toBe('string');
    // Internal error message must not appear in public response
    expect(JSON.stringify(body)).not.toContain('kaboom');
  });

  it('wraps error with cause chain, cause details do not appear in public response', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const root = new Error('pg connection refused — secret');
    const wrapped = new Error('outer');
    Object.defineProperty(wrapped, 'cause', { value: root, enumerable: true });
    handler(wrapped, buildMockReq(), res, vi.fn());

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as object;
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('pg connection refused');
    expect(bodyStr).not.toContain('outer');
  });
});

// ---------------------------------------------------------------------------
// Non-Error thrown values
// ---------------------------------------------------------------------------

describe('createErrorHandler — thrown non-Error values', () => {
  it('handles a thrown string → 500 INTERNAL_ERROR', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler('something went wrong' as unknown as Error, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('INTERNAL_ERROR');
    expect(body.error['message']).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('something went wrong');
  });

  it('handles a thrown object literal → 500 INTERNAL_ERROR', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(
      { code: 'DB_DOWN', detail: 'secret' } as unknown as Error,
      buildMockReq(),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('handles a thrown null → 500 INTERNAL_ERROR', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(null as unknown as Error, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------------------------------------------------------------------
// Body-parser errors (normalized to ValidationError)
// ---------------------------------------------------------------------------

describe('createErrorHandler — body-parser errors', () => {
  it('translates entity.too.large to 400 VALIDATION', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const err = Object.assign(new Error('too big'), { type: 'entity.too.large' });
    handler(err, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('VALIDATION');
    expect(body.error['message']).toBe('Request body too large');
    expect(body.error).not.toHaveProperty('errorId');
  });

  it('translates entity.parse.failed to 400 VALIDATION', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const err = Object.assign(new Error('bad json'), { type: 'entity.parse.failed' });
    handler(err, buildMockReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['code']).toBe('VALIDATION');
    expect(body.error['message']).toBe('Request body is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — double next(err) does NOT send two responses
// ---------------------------------------------------------------------------

describe('createErrorHandler — idempotency (res.headersSent guard)', () => {
  it('does nothing on second invocation when headersSent is true', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();

    // First call sends the response
    handler(new NotFoundError(), buildMockReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledTimes(1);

    // Simulate response already sent
    (res as Record<string, unknown>).headersSent = true;

    // Second call must be a no-op
    handler(new NotFoundError(), buildMockReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Metrics counter integration
// ---------------------------------------------------------------------------

describe('createErrorHandler — metrics integration', () => {
  it('increments errorsTotal with correct code and status labels', () => {
    const metricsRegistry = new MetricsRegistry({ collectDefaults: false });
    const incSpy = vi.spyOn(metricsRegistry.errorsTotal, 'inc');

    const handler = createErrorHandler(silentLogger, { metrics: metricsRegistry });
    const res = buildMockRes();
    handler(new NotFoundError(), buildMockReq(), res, vi.fn());

    expect(incSpy).toHaveBeenCalledWith({ code: 'NOT_FOUND', status: '404' });
  });

  it('increments errorsTotal for 500 with INTERNAL_ERROR code', () => {
    const metricsRegistry = new MetricsRegistry({ collectDefaults: false });
    const incSpy = vi.spyOn(metricsRegistry.errorsTotal, 'inc');

    const handler = createErrorHandler(silentLogger, { metrics: metricsRegistry });
    const res = buildMockRes();
    handler(new Error('boom'), buildMockReq(), res, vi.fn());

    expect(incSpy).toHaveBeenCalledWith({ code: 'INTERNAL_ERROR', status: '500' });
  });

  it('does not throw when no metrics registry is provided', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    expect(() => handler(new NotFoundError(), buildMockReq(), res, vi.fn())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// errorId — unique per call
// ---------------------------------------------------------------------------

describe('createErrorHandler — errorId', () => {
  it('each 5xx response has a different errorId', () => {
    const handler = createErrorHandler(silentLogger);

    const res1 = buildMockRes();
    const res2 = buildMockRes();
    handler(new InternalError(), buildMockReq(), res1, vi.fn());
    handler(new InternalError(), buildMockReq(), res2, vi.fn());

    const body1 = (res1.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    const body2 = (res2.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body1.error['errorId']).not.toBe(body2.error['errorId']);
  });

  it('4xx responses never include errorId', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new ValidationError('bad'), buildMockReq(), res, vi.fn());

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error).not.toHaveProperty('errorId');
  });
});

// ---------------------------------------------------------------------------
// requestId propagation
// ---------------------------------------------------------------------------

describe('createErrorHandler — requestId', () => {
  it('includes requestId from req.id in response', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    handler(new NotFoundError(), buildMockReq({ id: 'my-custom-id' }), res, vi.fn());

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['requestId']).toBe('my-custom-id');
  });

  it('uses "unknown" as requestId when req.id is absent', () => {
    const handler = createErrorHandler(silentLogger);
    const res = buildMockRes();
    const req = buildMockReq();
    delete (req as Record<string, unknown>)['id'];
    handler(new NotFoundError(), req, res, vi.fn());

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(body.error['requestId']).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// AppError subclass instanceof check — all handled correctly
// ---------------------------------------------------------------------------

describe('createErrorHandler — AppError subclass instanceof check', () => {
  const subclasses: [string, AppError, number][] = [
    ['ValidationError', new ValidationError(), 400],
    ['NotFoundError', new NotFoundError(), 404],
    ['ConflictError', new ConflictError(), 409],
    ['DependencyError', new DependencyError(), 503],
    ['InternalError', new InternalError(), 500],
  ];

  for (const [name, err, expectedStatus] of subclasses) {
    it(`${name} → status ${expectedStatus}`, () => {
      const handler = createErrorHandler(silentLogger);
      const res = buildMockRes();
      handler(err, buildMockReq(), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(expectedStatus);
    });
  }
});
