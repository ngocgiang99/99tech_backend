import type { FastifyRequest } from 'fastify';

import {
  DependencyUnavailableError,
  InternalError,
  ValidationError,
} from '../../../../src/scoreboard/shared/errors/domain-error';
import {
  MAX_QUERY_BYTES,
  buildErrorMetadata,
  walkCause,
} from '../../../../src/scoreboard/shared/errors/error-metadata';
import { attachPgCode } from '../../../../src/scoreboard/shared/errors/map-db-error';

function makeRequest(
  overrides: Partial<Record<string, unknown>> = {},
): FastifyRequest & { requestId?: string } {
  return {
    method: 'POST',
    url: '/v1/scores:increment',
    headers: {},
    routeOptions: { url: '/v1/scores:increment' },
    ip: '10.0.0.1',
    ...overrides,
  } as unknown as FastifyRequest & { requestId?: string };
}

describe('walkCause', () => {
  it('walks a chain of depth 3', () => {
    const e4 = new Error('e4');
    const e3 = new Error('e3', { cause: e4 });
    const e2 = new Error('e2', { cause: e3 });
    const e1 = new Error('e1', { cause: e2 });
    const chain = walkCause(e1);
    expect(chain).toHaveLength(3);
    expect(chain[0]).toEqual({ class: 'Error', message: 'e2' });
    expect(chain[1]).toEqual({ class: 'Error', message: 'e3' });
    expect(chain[2]).toEqual({ class: 'Error', message: 'e4' });
  });

  it('stops at depth 5 even for a longer chain', () => {
    const e7 = new Error('e7');
    const e6 = new Error('e6', { cause: e7 });
    const e5 = new Error('e5', { cause: e6 });
    const e4 = new Error('e4', { cause: e5 });
    const e3 = new Error('e3', { cause: e4 });
    const e2 = new Error('e2', { cause: e3 });
    const e1 = new Error('e1', { cause: e2 });
    const chain = walkCause(e1);
    expect(chain).toHaveLength(5);
    expect(chain[0].message).toBe('e2');
    expect(chain[4].message).toBe('e6');
  });

  it('returns empty array when cause is not an Error', () => {
    const e = new Error('top', { cause: 'string cause' });
    expect(walkCause(e)).toEqual([]);
  });

  it('returns empty when the input is not an Error', () => {
    expect(walkCause('plain string')).toEqual([]);
    expect(walkCause(null)).toEqual([]);
  });
});

describe('buildErrorMetadata', () => {
  it('captures all required fields for a ValidationError', () => {
    const err = new ValidationError('bad', { field: 'delta' });
    const req = makeRequest({
      headers: {
        'content-length': '47',
        'content-type': 'application/json',
        authorization: 'Bearer secret',
        'user-agent': 'jest/1',
      },
      requestId: 'req-1',
    });
    const metadata = buildErrorMetadata(err, req, 'err-uuid');

    expect(metadata.errorId).toBe('err-uuid');
    expect(metadata.errorClass).toBe('ValidationError');
    expect(metadata.code).toBe('VALIDATION');
    expect(metadata.status).toBe(400);
    expect(metadata.message).toBe('bad');
    expect(metadata.requestId).toBe('req-1');
    expect(metadata.method).toBe('POST');
    expect(metadata.route).toBe('/v1/scores:increment');
    expect(metadata.body.size).toBe(47);
    expect(metadata.body.contentType).toBe('application/json');
    expect(metadata.userAgent).toBe('jest/1');
    expect(metadata.remoteAddr).toBe('10.0.0.1');
    expect(metadata.headers['authorization']).toBe('[redacted]');
    expect(metadata.headers['content-type']).toBe('application/json');
    expect(typeof metadata.timestamp).toBe('string');
  });

  it('walks the cause chain down to depth 5', () => {
    const e6 = new Error('e6');
    const e5 = new Error('e5', { cause: e6 });
    const e4 = new Error('e4', { cause: e5 });
    const e3 = new Error('e3', { cause: e4 });
    const e2 = new Error('e2', { cause: e3 });
    const err = new InternalError('top', { cause: e2 });
    const metadata = buildErrorMetadata(err, makeRequest(), 'id');
    // walker includes e2..e6 (5 levels), excludes the top InternalError
    // which is captured as `errorClass` / `message`.
    expect(metadata.cause).toHaveLength(5);
    expect(metadata.cause[0].message).toBe('e2');
    expect(metadata.cause[4].message).toBe('e6');
  });

  it('caps the query string at 2048 bytes with "..." suffix', () => {
    const longQuery = 'a'.repeat(5000);
    const req = makeRequest({
      url: `/v1/things?${longQuery}`,
      routeOptions: { url: '/v1/things' },
    });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.query.length).toBe(MAX_QUERY_BYTES + 3);
    expect(metadata.query.endsWith('...')).toBe(true);
  });

  it('body.size is null when content-length header is missing', () => {
    const metadata = buildErrorMetadata(
      new ValidationError(),
      makeRequest({ headers: {} }),
      'id',
    );
    expect(metadata.body.size).toBeNull();
    expect(metadata.body.contentType).toBeNull();
  });

  it('captures pgCode when attached non-enumerably', () => {
    const err = new InternalError('db err');
    attachPgCode(err, '23505');
    const metadata = buildErrorMetadata(err, makeRequest(), 'id');
    expect(metadata.pgCode).toBe('23505');
  });

  it('uses __unmatched when no route or url', () => {
    const req = makeRequest({ url: undefined, routeOptions: undefined });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.route).toBe('__unmatched');
  });

  it('includes stack when err has one', () => {
    const err = new DependencyUnavailableError('service down');
    const metadata = buildErrorMetadata(err, makeRequest(), 'id');
    expect(typeof metadata.stack).toBe('string');
    expect(metadata.stack).toContain('DependencyUnavailableError');
  });

  it('reads first element when a header value is an array (Fastify multi-value)', () => {
    const req = makeRequest({
      headers: {
        'user-agent': ['jest/1', 'jest/2'],
        'content-length': ['99'],
        'content-type': ['application/json'],
      },
    });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.userAgent).toBe('jest/1');
    expect(metadata.body.size).toBe(99);
    expect(metadata.body.contentType).toBe('application/json');
  });

  it('returns null userAgent when header is a non-string non-array value', () => {
    const req = makeRequest({ headers: { 'user-agent': 42 } });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.userAgent).toBeNull();
  });

  it('falls back to socket.remoteAddress when request.ip is not set', () => {
    const req = makeRequest({
      ip: undefined,
      socket: { remoteAddress: '192.168.1.10' },
    });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.remoteAddr).toBe('192.168.1.10');
  });

  it('returns null remoteAddr when neither ip nor socket is present', () => {
    const req = makeRequest({ ip: undefined });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.remoteAddr).toBeNull();
  });

  it('returns empty query string when url has no query', () => {
    const req = makeRequest({ url: '/v1/plain' });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.query).toBe('');
  });

  it('method defaults to UNKNOWN when missing', () => {
    const req = makeRequest({ method: undefined });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.method).toBe('UNKNOWN');
  });

  it('body.size is null when content-length is non-numeric', () => {
    const req = makeRequest({ headers: { 'content-length': 'not-a-number' } });
    const metadata = buildErrorMetadata(new ValidationError(), req, 'id');
    expect(metadata.body.size).toBeNull();
  });
});
