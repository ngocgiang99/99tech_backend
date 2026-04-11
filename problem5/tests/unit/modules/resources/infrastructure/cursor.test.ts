import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  sortConfigFor,
  type TimestampCursor,
  type NameCursor,
} from '../../../../../src/modules/resources/infrastructure/cursor.js';
import { ValidationError } from '../../../../../src/shared/errors.js';

describe('cursor encode/decode (timestamp variant)', () => {
  const sampleTimestamp: TimestampCursor = {
    kind: 'timestamp',
    value: new Date('2026-04-11T10:00:00.000Z'),
    id: '11111111-1111-1111-1111-111111111111',
    sort: '-createdAt',
  };

  it('round-trips a timestamp cursor', () => {
    const encoded = encodeCursor(sampleTimestamp);
    const decoded = decodeCursor(encoded, '-createdAt');
    expect(decoded.kind).toBe('timestamp');
    expect(decoded).toEqual(sampleTimestamp);
    // value specifically must come back as a real Date (not a string)
    expect((decoded as TimestampCursor).value).toBeInstanceOf(Date);
    expect((decoded as TimestampCursor).value.toISOString()).toBe(sampleTimestamp.value.toISOString());
  });

  it('round-trips for every timestamp sort literal', () => {
    const sorts = ['-createdAt', 'createdAt', '-updatedAt', 'updatedAt'] as const;
    for (const sort of sorts) {
      const payload: TimestampCursor = { kind: 'timestamp', value: new Date(), id: 'x', sort };
      const encoded = encodeCursor(payload);
      const decoded = decodeCursor(encoded, sort);
      expect(decoded.sort).toBe(sort);
    }
  });

  it('produces different strings for different timestamp values', () => {
    const a = encodeCursor({ ...sampleTimestamp, value: new Date('2026-04-11T10:00:00Z') });
    const b = encodeCursor({ ...sampleTimestamp, value: new Date('2026-04-11T11:00:00Z') });
    expect(a).not.toBe(b);
  });

  it('rejects a timestamp cursor decoded under a name sort', () => {
    const cursor = encodeCursor(sampleTimestamp);
    expect(() => decodeCursor(cursor, 'name')).toThrow(ValidationError);
  });

  it('rejects a timestamp cursor whose encoded sort disagrees with the request sort', () => {
    const encoded = encodeCursor(sampleTimestamp); // sort=-createdAt
    expect(() => decodeCursor(encoded, 'createdAt')).toThrow(/sort mismatch/);
  });

  it('rejects a payload with a malformed timestamp value', () => {
    const bad = Buffer.from(
      JSON.stringify({ kind: 'timestamp', value: 'not-a-date', id: 'x', sort: '-createdAt' }),
    ).toString('base64url');
    expect(() => decodeCursor(bad, '-createdAt')).toThrow(/value is not a valid timestamp/);
  });
});

describe('cursor encode/decode (name variant)', () => {
  const sampleName: NameCursor = {
    kind: 'name',
    value: 'zebra',
    id: '22222222-2222-2222-2222-222222222222',
    sort: 'name',
  };

  it('round-trips a name cursor', () => {
    const encoded = encodeCursor(sampleName);
    const decoded = decodeCursor(encoded, 'name');
    expect(decoded.kind).toBe('name');
    expect(decoded).toEqual(sampleName);
  });

  it('round-trips for every name sort literal', () => {
    for (const sort of ['name', '-name'] as const) {
      const payload: NameCursor = { kind: 'name', value: 'aardvark', id: 'x', sort };
      const encoded = encodeCursor(payload);
      const decoded = decodeCursor(encoded, sort);
      expect(decoded.sort).toBe(sort);
    }
  });

  it('rejects a name cursor decoded under a timestamp sort', () => {
    const cursor = encodeCursor(sampleName);
    expect(() => decodeCursor(cursor, '-createdAt')).toThrow(ValidationError);
  });

  it('rejects a name cursor whose encoded sort disagrees with the request sort', () => {
    const encoded = encodeCursor(sampleName); // sort=name
    expect(() => decodeCursor(encoded, '-name')).toThrow(/sort mismatch/);
  });

  it('rejects a payload with a non-string name value', () => {
    const bad = Buffer.from(
      JSON.stringify({ kind: 'name', value: 42, id: 'x', sort: 'name' }),
    ).toString('base64url');
    expect(() => decodeCursor(bad, 'name')).toThrow(/malformed value/);
  });
});

describe('cursor encode/decode (error cases)', () => {
  it('rejects garbage base64url input as ValidationError', () => {
    // Node's base64url decoder is permissive with many characters, so
    // we assert via a followup JSON parse failure rather than a direct
    // decode failure. Either failure mode produces ValidationError.
    expect(() => decodeCursor('!!!not-base64!!!', '-createdAt')).toThrow(ValidationError);
  });

  it('rejects malformed JSON inside a valid base64 wrapper', () => {
    const badBase64 = Buffer.from('not-json').toString('base64url');
    expect(() => decodeCursor(badBase64, '-createdAt')).toThrow(ValidationError);
  });

  it('rejects a legacy-shape cursor missing the kind field', () => {
    // Pre-refactor cursors had shape { createdAt, id, sort }. Under the
    // new discriminated union they must fail closed with ValidationError.
    const legacy = Buffer.from(
      JSON.stringify({ createdAt: '2026-04-11T00:00:00Z', id: 'x', sort: '-createdAt' }),
    ).toString('base64url');
    expect(() => decodeCursor(legacy, '-createdAt')).toThrow(/kind mismatch/);
  });

  it('rejects a cursor whose kind disagrees with the codec the sort routes to', () => {
    const mismatched = Buffer.from(
      JSON.stringify({ kind: 'name', value: 'x', id: 'y', sort: '-createdAt' }),
    ).toString('base64url');
    expect(() => decodeCursor(mismatched, '-createdAt')).toThrow(/kind mismatch/);
  });
});

describe('sortConfigFor', () => {
  it('maps each sort literal to its SQL sort config', () => {
    expect(sortConfigFor('-createdAt')).toEqual({
      column: 'created_at',
      direction: 'desc',
      secondaryColumn: 'id',
      secondaryDirection: 'desc',
    });
    expect(sortConfigFor('createdAt')).toEqual({
      column: 'created_at',
      direction: 'asc',
      secondaryColumn: 'id',
      secondaryDirection: 'asc',
    });
    expect(sortConfigFor('-updatedAt').column).toBe('updated_at');
    expect(sortConfigFor('updatedAt').direction).toBe('asc');
    expect(sortConfigFor('name').column).toBe('name');
    expect(sortConfigFor('-name').direction).toBe('desc');
  });
});
