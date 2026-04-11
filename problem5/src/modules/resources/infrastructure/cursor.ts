import { ValidationError } from '../../../shared/errors.js';
import type { SortValue } from '../schema.js';

// ---------------------------------------------------------------------------
// Cursor payload: discriminated union
// ---------------------------------------------------------------------------

/**
 * Cursor for a query sorted by a timestamp column (created_at / updated_at).
 * The `value` carries the last row's timestamp as a `Date`, and the SQL
 * keyset predicate compares it against the timestamp column directly.
 */
export interface TimestampCursor {
  kind: 'timestamp';
  value: Date;
  id: string;
  sort: '-createdAt' | 'createdAt' | '-updatedAt' | 'updatedAt';
}

/**
 * Cursor for a query sorted by the `name` column. The `value` carries the
 * last row's name — NOT a timestamp. This is the variant whose pre-refactor
 * ancestor had a latent bug (compared `name` against a timestamp string);
 * the type system now forces the comparison to be name-vs-name.
 */
export interface NameCursor {
  kind: 'name';
  value: string;
  id: string;
  sort: 'name' | '-name';
}

export type CursorPayload = TimestampCursor | NameCursor;

// ---------------------------------------------------------------------------
// Sort config: where the cursor meets Kysely
// ---------------------------------------------------------------------------

/**
 * The SQL ordering configuration derived from a `SortValue`. Moved out of
 * `repository.ts` into `cursor.ts` because the mapping from sort value to
 * SQL column now lives on each cursor codec — two switches on `SortValue`
 * (one for cursor variants, one for SQL columns) collapse into one.
 */
export interface SortConfig {
  column: 'created_at' | 'updated_at' | 'name';
  direction: 'asc' | 'desc';
  secondaryColumn: 'id';
  secondaryDirection: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Cursor codec: uniform contract per variant
// ---------------------------------------------------------------------------

/**
 * Each cursor variant implements this contract. A codec owns three
 * responsibilities for its variant:
 *
 *   - `encode` / `decode` — serialize to / from the opaque wire string.
 *   - `configFor`         — map one of this codec's sort values to its
 *                            SQL sort config.
 *
 * Adding a new cursor variant is a purely additive change: declare the type,
 * write a codec, add two lines to `codecForSort`. No existing codec changes
 * and no function elsewhere grows a new case.
 */
export interface CursorCodec<T extends CursorPayload> {
  readonly kind: T['kind'];
  /** Sort literals this codec is responsible for. Used by `codecForSort`. */
  readonly handles: ReadonlyArray<T['sort']>;
  encode(payload: T): string;
  /**
   * Validates the parsed object, narrows to T, throws `ValidationError` on
   * mismatch. `sort` is the caller's request sort, pre-narrowed to one of
   * this codec's `handles` values by the dispatcher.
   */
  decode(raw: unknown, sort: T['sort']): T;
  configFor(sort: T['sort']): SortConfig;
}

// ---------------------------------------------------------------------------
// Shared envelope helpers
// ---------------------------------------------------------------------------

function toBase64Url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function fromBase64Url(s: string): unknown {
  let json: string;
  try {
    json = Buffer.from(s, 'base64url').toString('utf-8');
  } catch {
    throw new ValidationError('Invalid cursor: cannot be decoded');
  }
  try {
    // Defensive narrowing: JSON.parse returns `any`; cast to `unknown` to
    // force the per-codec validation gate below. This is the one `as unknown`
    // in the resources module that stays — it tightens, not loosens, typing.
    return JSON.parse(json) as unknown;
  } catch {
    throw new ValidationError('Invalid cursor: cannot be decoded');
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

// ---------------------------------------------------------------------------
// Timestamp codec
// ---------------------------------------------------------------------------

const TIMESTAMP_HANDLES = ['-createdAt', 'createdAt', '-updatedAt', 'updatedAt'] as const;

export const TimestampCursorCodec: CursorCodec<TimestampCursor> = {
  kind: 'timestamp',
  handles: TIMESTAMP_HANDLES,

  encode(payload) {
    return toBase64Url({
      kind: payload.kind,
      value: payload.value.toISOString(),
      id: payload.id,
      sort: payload.sort,
    });
  },

  decode(raw, sort) {
    if (!isRecord(raw)) {
      throw new ValidationError('Invalid cursor: malformed payload');
    }
    if (raw['kind'] !== 'timestamp') {
      throw new ValidationError(
        `Invalid cursor: kind mismatch (expected "timestamp", got ${JSON.stringify(raw['kind'])})`,
      );
    }
    const valueRaw = raw['value'];
    if (typeof valueRaw !== 'string') {
      throw new ValidationError('Invalid cursor: malformed value');
    }
    const value = new Date(valueRaw);
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError('Invalid cursor: value is not a valid timestamp');
    }
    if (typeof raw['id'] !== 'string') {
      throw new ValidationError('Invalid cursor: malformed id');
    }
    if (raw['sort'] !== sort) {
      throw new ValidationError(
        `Invalid cursor: sort mismatch (cursor was generated with sort="${String(raw['sort'])}", request uses sort="${sort}")`,
      );
    }
    return { kind: 'timestamp', value, id: raw['id'], sort };
  },

  configFor(sort) {
    switch (sort) {
      case '-createdAt':
        return { column: 'created_at', direction: 'desc', secondaryColumn: 'id', secondaryDirection: 'desc' };
      case 'createdAt':
        return { column: 'created_at', direction: 'asc', secondaryColumn: 'id', secondaryDirection: 'asc' };
      case '-updatedAt':
        return { column: 'updated_at', direction: 'desc', secondaryColumn: 'id', secondaryDirection: 'desc' };
      case 'updatedAt':
        return { column: 'updated_at', direction: 'asc', secondaryColumn: 'id', secondaryDirection: 'asc' };
    }
  },
};

// ---------------------------------------------------------------------------
// Name codec
// ---------------------------------------------------------------------------

const NAME_HANDLES = ['name', '-name'] as const;

export const NameCursorCodec: CursorCodec<NameCursor> = {
  kind: 'name',
  handles: NAME_HANDLES,

  encode(payload) {
    return toBase64Url({
      kind: payload.kind,
      value: payload.value,
      id: payload.id,
      sort: payload.sort,
    });
  },

  decode(raw, sort) {
    if (!isRecord(raw)) {
      throw new ValidationError('Invalid cursor: malformed payload');
    }
    if (raw['kind'] !== 'name') {
      throw new ValidationError(
        `Invalid cursor: kind mismatch (expected "name", got ${JSON.stringify(raw['kind'])})`,
      );
    }
    if (typeof raw['value'] !== 'string') {
      throw new ValidationError('Invalid cursor: malformed value');
    }
    if (typeof raw['id'] !== 'string') {
      throw new ValidationError('Invalid cursor: malformed id');
    }
    if (raw['sort'] !== sort) {
      throw new ValidationError(
        `Invalid cursor: sort mismatch (cursor was generated with sort="${String(raw['sort'])}", request uses sort="${sort}")`,
      );
    }
    return { kind: 'name', value: raw['value'], id: raw['id'], sort };
  },

  configFor(sort) {
    switch (sort) {
      case '-name':
        return { column: 'name', direction: 'desc', secondaryColumn: 'id', secondaryDirection: 'desc' };
      case 'name':
        return { column: 'name', direction: 'asc', secondaryColumn: 'id', secondaryDirection: 'asc' };
    }
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
//
// Each public function dispatches on `sort` directly (or on `payload.kind`
// for `encodeCursor`). This puts the one-and-only partition of `SortValue`
// across codecs in one place per function, with TypeScript narrowing `sort`
// to the precise variant literals on each branch. The upshot is ZERO casts
// — each branch of each switch passes a statically-typed sort literal into
// its codec.
//
// Adding a new cursor variant is still purely additive: declare the type,
// write its codec, add a branch group to each of the three switches below.
// Forgetting any one of them is a compile error (TypeScript's exhaustive
// `never` check catches it).

export function encodeCursor(payload: CursorPayload): string {
  switch (payload.kind) {
    case 'timestamp':
      return TimestampCursorCodec.encode(payload);
    case 'name':
      return NameCursorCodec.encode(payload);
    default: {
      const _exhaustive: never = payload;
      return _exhaustive;
    }
  }
}

export function decodeCursor(raw: string, sort: SortValue): CursorPayload {
  const parsed = fromBase64Url(raw);
  switch (sort) {
    case '-createdAt':
    case 'createdAt':
    case '-updatedAt':
    case 'updatedAt':
      return TimestampCursorCodec.decode(parsed, sort);
    case 'name':
    case '-name':
      return NameCursorCodec.decode(parsed, sort);
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}

export function sortConfigFor(sort: SortValue): SortConfig {
  switch (sort) {
    case '-createdAt':
    case 'createdAt':
    case '-updatedAt':
    case 'updatedAt':
      return TimestampCursorCodec.configFor(sort);
    case 'name':
    case '-name':
      return NameCursorCodec.configFor(sort);
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}
