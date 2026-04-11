import {
  DEFAULT_HEADER_DENYLIST,
  scrubHeaders,
} from '../../../../src/scoreboard/shared/errors/scrub-headers';

describe('scrubHeaders', () => {
  it('redacts every default denylist entry', () => {
    const headers = {
      authorization: 'Bearer xyz',
      cookie: 'session=abc',
      'set-cookie': 'id=1',
      'x-api-key': 'k',
      'action-token': 'tok',
      'content-type': 'application/json',
    };
    const out = scrubHeaders(headers);
    expect(out['authorization']).toBe('[redacted]');
    expect(out['cookie']).toBe('[redacted]');
    expect(out['set-cookie']).toBe('[redacted]');
    expect(out['x-api-key']).toBe('[redacted]');
    expect(out['action-token']).toBe('[redacted]');
    expect(out['content-type']).toBe('application/json');
  });

  it('matches header names case-insensitively', () => {
    const out = scrubHeaders({
      Authorization: 'Bearer xyz',
      COOKIE: 'session=abc',
      'X-Api-Key': 'k',
    });
    expect(out['Authorization']).toBe('[redacted]');
    expect(out['COOKIE']).toBe('[redacted]');
    expect(out['X-Api-Key']).toBe('[redacted]');
  });

  it('supports an extra denylist', () => {
    const out = scrubHeaders(
      { 'x-custom-token': 'secret', 'content-type': 'json' },
      ['x-custom-token'],
    );
    expect(out['x-custom-token']).toBe('[redacted]');
    expect(out['content-type']).toBe('json');
  });

  it('passes non-denylist headers through unchanged', () => {
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'jest',
      'x-request-id': 'req-1',
    };
    const out = scrubHeaders(headers);
    expect(out).toEqual(headers);
  });

  it('returns a new object, does not mutate the input', () => {
    const headers = { authorization: 'Bearer xyz' };
    const out = scrubHeaders(headers);
    expect(out).not.toBe(headers);
    expect(headers['authorization']).toBe('Bearer xyz');
  });

  it('default denylist contains the five expected names', () => {
    expect(DEFAULT_HEADER_DENYLIST).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'action-token',
    ]);
  });
});
