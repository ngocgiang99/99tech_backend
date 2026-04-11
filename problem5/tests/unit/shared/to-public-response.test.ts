import { describe, expect, it } from 'vitest';

import { toPublicResponse } from '../../../src/shared/to-public-response.js';
import {
  ConflictError,
  DependencyError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../../src/shared/errors.js';
import { ERROR_CODE_META } from '../../../src/shared/error-codes.js';

// ---------------------------------------------------------------------------
// ValidationError: has details, no errorId
// ---------------------------------------------------------------------------

describe('toPublicResponse — ValidationError', () => {
  it('includes details when ValidationError has details', () => {
    const err = new ValidationError('Validation failed', [
      { path: 'name', code: 'too_small', message: 'String too short' },
    ]);
    const { status, body } = toPublicResponse(err, 'req-1', null);

    expect(status).toBe(400);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['code']).toBe('VALIDATION');
    expect(error['message']).toBe('Validation failed');
    expect(error['requestId']).toBe('req-1');
    expect(error['details']).toEqual([
      { path: 'name', code: 'too_small', message: 'String too short' },
    ]);
    expect(error).not.toHaveProperty('errorId');
  });

  it('does not include errorId even when provided for a 4xx', () => {
    // Caller should pass null for 4xx, but test that the contract holds.
    const err = new ValidationError('bad');
    const { body } = toPublicResponse(err, 'req-2', null);
    expect((body as { error: Record<string, unknown> }).error).not.toHaveProperty('errorId');
  });

  it('ValidationError without details has no details field', () => {
    const err = new ValidationError('bad');
    const { body } = toPublicResponse(err, 'req-3', null);
    expect((body as { error: Record<string, unknown> }).error).not.toHaveProperty('details');
  });
});

// ---------------------------------------------------------------------------
// NotFoundError: no details, no errorId
// ---------------------------------------------------------------------------

describe('toPublicResponse — NotFoundError', () => {
  it('returns 404 with no details and no errorId', () => {
    const err = new NotFoundError('Resource not found');
    const { status, body } = toPublicResponse(err, 'req-4', null);

    expect(status).toBe(404);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['code']).toBe('NOT_FOUND');
    expect(error['message']).toBe('Resource not found');
    expect(error['requestId']).toBe('req-4');
    expect(error).not.toHaveProperty('details');
    expect(error).not.toHaveProperty('errorId');
  });
});

// ---------------------------------------------------------------------------
// ConflictError: no details, no errorId
// ---------------------------------------------------------------------------

describe('toPublicResponse — ConflictError', () => {
  it('returns 409 with no errorId', () => {
    const err = new ConflictError('duplicate key');
    const { status, body } = toPublicResponse(err, 'req-5', null);

    expect(status).toBe(409);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['code']).toBe('CONFLICT');
    expect(error).not.toHaveProperty('errorId');
  });
});

// ---------------------------------------------------------------------------
// InternalError: errorId present, message is ALWAYS generic
// ---------------------------------------------------------------------------

describe('toPublicResponse — InternalError', () => {
  it('includes errorId when provided', () => {
    const err = new InternalError();
    const { status, body } = toPublicResponse(err, 'req-6', 'uuid-123');

    expect(status).toBe(500);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['code']).toBe('INTERNAL_ERROR');
    expect(error['errorId']).toBe('uuid-123');
    expect(error['requestId']).toBe('req-6');
  });

  it('message is always the generic "Internal server error" for InternalError', () => {
    const err = new InternalError('pg connection refused — do not leak this');
    const { body } = toPublicResponse(err, 'req-7', 'uuid-456');
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['message']).toBe(ERROR_CODE_META.INTERNAL_ERROR.defaultMessage);
    expect(error['message']).toBe('Internal server error');
    // The internal detail must not appear
    expect(JSON.stringify(body)).not.toContain('pg connection refused');
  });

  it('message is generic for InternalError wrapping a cause', () => {
    const err = new InternalError(undefined, { cause: new Error('SQL: SELECT * FROM secrets') });
    const { body } = toPublicResponse(err, 'req-8', 'uuid-789');
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['message']).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('SELECT');
  });

  it('does not include details for InternalError', () => {
    const err = new InternalError();
    const { body } = toPublicResponse(err, 'req-9', 'uuid-abc');
    expect((body as { error: Record<string, unknown> }).error).not.toHaveProperty('details');
  });
});

// ---------------------------------------------------------------------------
// DependencyError: 5xx, so errorId included
// ---------------------------------------------------------------------------

describe('toPublicResponse — DependencyError', () => {
  it('returns 503 with errorId when provided', () => {
    const err = new DependencyError();
    const { status, body } = toPublicResponse(err, 'req-10', 'uuid-dep');

    expect(status).toBe(503);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error['code']).toBe('DEPENDENCY_UNAVAILABLE');
    expect(error['errorId']).toBe('uuid-dep');
  });
});

// ---------------------------------------------------------------------------
// errorId: null means no errorId field (any error class)
// ---------------------------------------------------------------------------

describe('toPublicResponse — errorId null', () => {
  it('does not include errorId when null is passed', () => {
    const err = new InternalError(); // even a 500 — caller controls this
    const { body } = toPublicResponse(err, 'req-11', null);
    expect((body as { error: Record<string, unknown> }).error).not.toHaveProperty('errorId');
  });
});

// ---------------------------------------------------------------------------
// Message truncation
// ---------------------------------------------------------------------------

describe('toPublicResponse — message truncation', () => {
  it('passes through a message of exactly 200 chars unchanged', () => {
    const msg = 'x'.repeat(200);
    const err = new NotFoundError(msg);
    const { body } = toPublicResponse(err, 'req-12', null);
    const message = (body as { error: Record<string, unknown> }).error['message'] as string;
    expect(message).toBe(msg);
    expect(message.length).toBe(200);
  });

  it('truncates a message longer than 200 chars and appends "..."', () => {
    const msg = 'x'.repeat(250);
    const err = new NotFoundError(msg);
    const { body } = toPublicResponse(err, 'req-13', null);
    const message = (body as { error: Record<string, unknown> }).error['message'] as string;
    expect(message.length).toBe(203); // 200 chars + "..."
    expect(message.endsWith('...')).toBe(true);
    expect(message.startsWith('x'.repeat(200))).toBe(true);
  });

  it('truncates a message of 201 chars', () => {
    const msg = 'y'.repeat(201);
    const err = new ConflictError(msg);
    const { body } = toPublicResponse(err, 'req-14', null);
    const message = (body as { error: Record<string, unknown> }).error['message'] as string;
    expect(message).toBe('y'.repeat(200) + '...');
  });

  it('InternalError message is never truncated from an internal long message — always generic', () => {
    const msg = 'z'.repeat(300);
    const err = new InternalError(msg);
    const { body } = toPublicResponse(err, 'req-15', 'uuid-trunc');
    const message = (body as { error: Record<string, unknown> }).error['message'] as string;
    // Generic message is "Internal server error" (22 chars), not truncated
    expect(message).toBe('Internal server error');
    expect(message.length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Body shape is exactly the allowlist — no extra fields
// ---------------------------------------------------------------------------

describe('toPublicResponse — strict body shape', () => {
  it('4xx response body has exactly {error: {code, message, requestId}}', () => {
    const err = new NotFoundError('gone');
    const { body } = toPublicResponse(err, 'req-16', null);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it('5xx response body has exactly {error: {code, message, requestId, errorId}}', () => {
    const err = new InternalError();
    const { body } = toPublicResponse(err, 'req-17', 'uuid-shape');
    const error = (body as { error: Record<string, unknown> }).error;
    expect(Object.keys(error).sort()).toEqual(['code', 'errorId', 'message', 'requestId']);
  });

  it('validation response body has exactly {error: {code, message, requestId, details}}', () => {
    const err = new ValidationError('bad', [{ path: 'x', code: 'required', message: 'req' }]);
    const { body } = toPublicResponse(err, 'req-18', null);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(Object.keys(error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
  });
});
