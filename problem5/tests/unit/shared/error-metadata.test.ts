import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';

import { buildErrorMetadata } from '../../../src/shared/error-metadata.js';
import {
  AppError,
  DependencyError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Record<string, unknown>> = {}): Request {
  return {
    id: 'req-test-id',
    method: 'GET',
    url: '/resources/abc-123',
    ip: '127.0.0.1',
    headers: {
      'content-type': 'application/json',
      'content-length': '42',
      'user-agent': 'test-agent/1.0',
    },
    route: { path: '/:id' },
    baseUrl: '/resources',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as unknown as Response;
}

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — required fields', () => {
  it('returns all required fields', () => {
    const err = new NotFoundError('Resource not found');
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());

    expect(typeof metadata.errorId).toBe('string');
    expect(metadata.errorId.length).toBeGreaterThan(0);
    expect(metadata.errorClass).toBe('NotFoundError');
    expect(metadata.code).toBe('NOT_FOUND');
    expect(metadata.status).toBe(404);
    expect(metadata.message).toBe('Resource not found');
    // stack may be undefined in some environments but the field must exist
    expect('stack' in metadata).toBe(true);
    expect(Array.isArray(metadata.cause)).toBe(true);
    expect(metadata.requestId).toBe('req-test-id');
    expect(metadata.method).toBe('GET');
    expect(typeof metadata.route).toBe('string');
    expect(typeof metadata.headers).toBe('object');
    expect(typeof metadata.query).toBe('string');
    expect(typeof metadata.body).toBe('object');
    expect('size' in metadata.body).toBe(true);
    expect('contentType' in metadata.body).toBe(true);
    expect(typeof metadata.timestamp).toBe('string');
    // ISO-8601 check
    expect(() => new Date(metadata.timestamp)).not.toThrow();
    expect(new Date(metadata.timestamp).toISOString()).toBe(metadata.timestamp);
  });

  it('errorId is a valid UUID v4 format', () => {
    const err = new NotFoundError();
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(metadata.errorId)).toBe(true);
  });

  it('each call generates a different errorId', () => {
    const err = new NotFoundError();
    const m1 = buildErrorMetadata(err, makeReq(), makeRes());
    const m2 = buildErrorMetadata(err, makeReq(), makeRes());
    expect(m1.errorId).not.toBe(m2.errorId);
  });
});

// ---------------------------------------------------------------------------
// Route extraction
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — route extraction', () => {
  it('extracts matched route pattern (baseUrl + path)', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ route: { path: '/:id' }, baseUrl: '/resources' }),
      makeRes(),
    );
    expect(metadata.route).toBe('/resources/:id');
  });

  it('falls back to __unmatched when route is not set', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ route: undefined }),
      makeRes(),
    );
    expect(metadata.route).toBe('__unmatched');
  });

  it('handles sub-router root path (baseUrl + /)', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ route: { path: '/' }, baseUrl: '/resources' }),
      makeRes(),
    );
    expect(metadata.route).toBe('/resources');
  });
});

// ---------------------------------------------------------------------------
// Body: size only, never content
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — body fields', () => {
  it('captures body.size from Content-Length header', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ headers: { 'content-length': '128' } }),
      makeRes(),
    );
    expect(metadata.body.size).toBe(128);
  });

  it('body.size is null when Content-Length is absent', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ headers: {} }),
      makeRes(),
    );
    expect(metadata.body.size).toBeNull();
  });

  it('captures body.contentType from Content-Type header', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ headers: { 'content-type': 'application/json' } }),
      makeRes(),
    );
    expect(metadata.body.contentType).toBe('application/json');
  });

  it('body.contentType is null when Content-Type is absent', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ headers: {} }),
      makeRes(),
    );
    expect(metadata.body.contentType).toBeNull();
  });

  it('body object never contains raw body content', () => {
    const metadata = buildErrorMetadata(
      new ValidationError('bad input'),
      makeReq(),
      makeRes(),
    );
    const bodyKeys = Object.keys(metadata.body);
    expect(bodyKeys).toEqual(['size', 'contentType']);
  });
});

// ---------------------------------------------------------------------------
// Cause chain walking
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — cause chain', () => {
  it('cause is empty array when err has no cause', () => {
    const err = new NotFoundError();
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.cause).toEqual([]);
  });

  it('walks a single-level cause', () => {
    const root = new Error('root cause');
    const err = new InternalError('wrapped', { cause: root });
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.cause).toEqual([{ class: 'Error', message: 'root cause' }]);
  });

  it('walks a two-level cause chain', () => {
    const level2 = new Error('level 2');
    const level1 = new Error('level 1');
    Object.defineProperty(level1, 'cause', { value: level2, enumerable: true });
    const err = new InternalError('top', { cause: level1 });
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.cause).toEqual([
      { class: 'Error', message: 'level 1' },
      { class: 'Error', message: 'level 2' },
    ]);
  });

  it('stops at depth 5', () => {
    // Build a chain of depth 6 — output should be capped at 5 entries.
    let deepest: Error = new Error('depth-6');
    for (let i = 5; i >= 1; i--) {
      const e = new Error(`depth-${i}`);
      Object.defineProperty(e, 'cause', { value: deepest, enumerable: true });
      deepest = e;
    }
    const err = new InternalError('top', { cause: deepest });
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.cause.length).toBe(5);
    expect(metadata.cause[0]).toEqual({ class: 'Error', message: 'depth-1' });
    expect(metadata.cause[4]).toEqual({ class: 'Error', message: 'depth-5' });
  });

  it('stops at first non-Error value in the chain', () => {
    const level1 = new Error('level 1');
    // Non-Error cause: a plain string
    Object.defineProperty(level1, 'cause', { value: 'string cause', enumerable: true });
    const err = new InternalError('top', { cause: level1 });
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    // Only level1 should appear — "string cause" is not an Error so walking stops
    expect(metadata.cause).toEqual([{ class: 'Error', message: 'level 1' }]);
  });
});

// ---------------------------------------------------------------------------
// Header scrubbing
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — sensitive header scrubbing', () => {
  it('redacts Authorization header', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({
        headers: {
          authorization: 'Bearer abc123',
          'content-type': 'application/json',
        },
      }),
      makeRes(),
    );
    expect(metadata.headers['authorization']).toBe('[REDACTED]');
    expect(metadata.headers['content-type']).toBe('application/json');
  });

  it('redacts Cookie header', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ headers: { cookie: 'session=xyz' } }),
      makeRes(),
    );
    expect(metadata.headers['cookie']).toBe('[REDACTED]');
  });

  it('accepts extra denylist via parameter', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ headers: { 'x-internal-secret': 'topsecret', safe: 'ok' } }),
      makeRes(),
      ['x-internal-secret'],
    );
    expect(metadata.headers['x-internal-secret']).toBe('[REDACTED]');
    expect(metadata.headers['safe']).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// pgCode passthrough (impl-db non-public property)
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — pgCode', () => {
  it('includes pgCode when set on the error', () => {
    const err = new InternalError('db error');
    Object.defineProperty(err, 'pgCode', { value: '23505', enumerable: false });
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.pgCode).toBe('23505');
  });

  it('pgCode is undefined when not set', () => {
    const err = new AppError('INTERNAL_ERROR', 'something', {});
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.pgCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Query string capping
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — query string', () => {
  it('extracts query string from URL', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ url: '/resources?name=foo&type=bar' }),
      makeRes(),
    );
    expect(metadata.query).toBe('name=foo&type=bar');
  });

  it('returns empty string when no query string', () => {
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ url: '/resources' }),
      makeRes(),
    );
    expect(metadata.query).toBe('');
  });

  it('caps query string at 2048 bytes with "..." suffix', () => {
    const longQuery = 'a='.padEnd(2100, 'x');
    const metadata = buildErrorMetadata(
      new NotFoundError(),
      makeReq({ url: `/resources?${longQuery}` }),
      makeRes(),
    );
    expect(metadata.query.length).toBe(2051); // 2048 + "...".length
    expect(metadata.query.endsWith('...')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DependencyError subclass
// ---------------------------------------------------------------------------

describe('buildErrorMetadata — error subclasses', () => {
  it('captures DependencyError fields correctly', () => {
    const err = new DependencyError('Redis down');
    const metadata = buildErrorMetadata(err, makeReq(), makeRes());
    expect(metadata.errorClass).toBe('DependencyError');
    expect(metadata.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(metadata.status).toBe(503);
  });
});
