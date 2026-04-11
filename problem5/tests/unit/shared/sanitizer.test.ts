import { describe, expect, it } from 'vitest';

import { scrubHeaders } from '../../../src/shared/sanitizer.js';

describe('scrubHeaders — default denylist', () => {
  it('redacts authorization (lowercase)', () => {
    const result = scrubHeaders({ authorization: 'Bearer abc123' });
    expect(result['authorization']).toBe('[REDACTED]');
  });

  it('redacts Authorization (mixed-case key)', () => {
    const result = scrubHeaders({ Authorization: 'Bearer abc123' });
    expect(result['Authorization']).toBe('[REDACTED]');
  });

  it('redacts AUTHORIZATION (uppercase key)', () => {
    const result = scrubHeaders({ AUTHORIZATION: 'Bearer abc123' });
    expect(result['AUTHORIZATION']).toBe('[REDACTED]');
  });

  it('redacts cookie', () => {
    const result = scrubHeaders({ cookie: 'session=abc' });
    expect(result['cookie']).toBe('[REDACTED]');
  });

  it('redacts set-cookie', () => {
    const result = scrubHeaders({ 'set-cookie': 'id=xyz; Path=/' });
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  it('redacts x-api-key', () => {
    const result = scrubHeaders({ 'x-api-key': 'supersecret' });
    expect(result['x-api-key']).toBe('[REDACTED]');
  });

  it('redacts x-auth-token', () => {
    const result = scrubHeaders({ 'x-auth-token': 'tok123' });
    expect(result['x-auth-token']).toBe('[REDACTED]');
  });

  it('redacts proxy-authorization', () => {
    const result = scrubHeaders({ 'proxy-authorization': 'Basic xyz' });
    expect(result['proxy-authorization']).toBe('[REDACTED]');
  });
});

describe('scrubHeaders — preservation of non-denylisted values', () => {
  it('preserves content-type unchanged', () => {
    const result = scrubHeaders({ 'content-type': 'application/json' });
    expect(result['content-type']).toBe('application/json');
  });

  it('preserves user-agent unchanged', () => {
    const result = scrubHeaders({ 'user-agent': 'Mozilla/5.0' });
    expect(result['user-agent']).toBe('Mozilla/5.0');
  });

  it('preserves x-request-id unchanged', () => {
    const result = scrubHeaders({ 'x-request-id': 'abc-123' });
    expect(result['x-request-id']).toBe('abc-123');
  });

  it('preserves numeric values unchanged', () => {
    const result = scrubHeaders({ 'content-length': 42 });
    expect(result['content-length']).toBe(42);
  });

  it('returns an empty object for empty headers', () => {
    expect(scrubHeaders({})).toEqual({});
  });
});

describe('scrubHeaders — mixed safe and sensitive', () => {
  it('redacts only sensitive headers, preserves safe ones', () => {
    const result = scrubHeaders({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      cookie: 'sid=1',
      'x-request-id': 'req-1',
    });
    expect(result['authorization']).toBe('[REDACTED]');
    expect(result['cookie']).toBe('[REDACTED]');
    expect(result['content-type']).toBe('application/json');
    expect(result['x-request-id']).toBe('req-1');
  });
});

describe('scrubHeaders — extra denylist parameter', () => {
  it('redacts a custom header added via extraDenylist', () => {
    const result = scrubHeaders(
      { 'x-internal-secret': 'topsecret' },
      ['x-internal-secret'],
    );
    expect(result['x-internal-secret']).toBe('[REDACTED]');
  });

  it('extra denylist matching is case-insensitive', () => {
    const result = scrubHeaders(
      { 'X-Internal-Secret': 'topsecret' },
      ['x-internal-secret'],
    );
    expect(result['X-Internal-Secret']).toBe('[REDACTED]');
  });

  it('multiple extra headers are all redacted', () => {
    const result = scrubHeaders(
      { 'x-jwt': 'eyJ...', 'x-session': 'sess123', safe: 'ok' },
      ['x-jwt', 'x-session'],
    );
    expect(result['x-jwt']).toBe('[REDACTED]');
    expect(result['x-session']).toBe('[REDACTED]');
    expect(result['safe']).toBe('ok');
  });

  it('empty extra denylist has no effect', () => {
    const result = scrubHeaders({ 'x-custom': 'value' }, []);
    expect(result['x-custom']).toBe('value');
  });
});

describe('scrubHeaders — array-valued headers (multi-value Set-Cookie)', () => {
  it('replaces an array-valued Set-Cookie header with a single "[REDACTED]" string', () => {
    // Array-valued Set-Cookie: the whole value is replaced by a single "[REDACTED]".
    const result = scrubHeaders({
      'set-cookie': ['id=1; Path=/', 'sid=2; Path=/'],
    });
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  it('replaces a single-string Set-Cookie value with "[REDACTED]"', () => {
    const result = scrubHeaders({ 'set-cookie': 'id=1; Path=/' });
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  it('preserves non-denylisted array-valued headers as-is', () => {
    const result = scrubHeaders({ accept: ['text/html', 'application/json'] });
    expect(result['accept']).toEqual(['text/html', 'application/json']);
  });
});
