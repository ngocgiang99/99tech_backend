import { ValidationError } from '../../lib/errors.js';

import type { SortValue } from './schema.js';

export interface CursorPayload {
  createdAt: string;
  id: string;
  sort: SortValue;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string, expectedSort: SortValue): CursorPayload {
  let payload: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    payload = JSON.parse(json) as unknown;
  } catch {
    throw new ValidationError('Invalid cursor: cannot be decoded');
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>)['createdAt'] !== 'string' ||
    typeof (payload as Record<string, unknown>)['id'] !== 'string' ||
    typeof (payload as Record<string, unknown>)['sort'] !== 'string'
  ) {
    throw new ValidationError('Invalid cursor: malformed payload');
  }

  const p = payload as CursorPayload;

  if (p.sort !== expectedSort) {
    throw new ValidationError(
      `Invalid cursor: sort mismatch (cursor was generated with sort="${p.sort}", request uses sort="${expectedSort}")`,
    );
  }

  return p;
}
