import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../../../../../src/modules/resources/application/cursor.js';
import { ValidationError } from '../../../../../src/shared/errors.js';

describe('cursor encode/decode', () => {
  it('round-trips a valid payload', () => {
    const payload = {
      createdAt: '2026-04-11T10:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      sort: '-createdAt' as const,
    };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded, '-createdAt');
    expect(decoded).toEqual(payload);
  });

  it('produces different strings for different payloads', () => {
    const a = encodeCursor({
      createdAt: '2026-04-11T10:00:00.000Z',
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sort: '-createdAt',
    });
    const b = encodeCursor({
      createdAt: '2026-04-11T11:00:00.000Z',
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      sort: '-createdAt',
    });
    expect(a).not.toBe(b);
  });

  it('rejects garbage input as ValidationError', () => {
    expect(() => decodeCursor('!!!not-base64!!!', '-createdAt')).toThrow(ValidationError);
  });

  it('rejects malformed JSON inside a valid base64 wrapper', () => {
    const badBase64 = Buffer.from('not-json').toString('base64url');
    expect(() => decodeCursor(badBase64, '-createdAt')).toThrow(ValidationError);
  });

  it('rejects a cursor whose payload is missing required fields', () => {
    const partial = Buffer.from(JSON.stringify({ createdAt: '2026-04-11T00:00:00Z' })).toString(
      'base64url',
    );
    expect(() => decodeCursor(partial, '-createdAt')).toThrow(ValidationError);
  });

  it('rejects a cursor whose sort does not match the request sort', () => {
    const cursor = encodeCursor({
      createdAt: '2026-04-11T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      sort: '-createdAt',
    });
    expect(() => decodeCursor(cursor, 'name')).toThrow(ValidationError);
  });

  it('accepts a cursor whose sort matches the request sort', () => {
    const cursor = encodeCursor({
      createdAt: '2026-04-11T00:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
      sort: 'name',
    });
    expect(() => decodeCursor(cursor, 'name')).not.toThrow();
  });
});
