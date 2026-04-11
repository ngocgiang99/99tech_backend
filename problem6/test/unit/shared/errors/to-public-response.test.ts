import {
  ConflictError,
  ForbiddenError,
  InternalError,
  RateLimitError,
  ValidationError,
} from '../../../../src/scoreboard/shared/errors/domain-error';
import {
  MESSAGE_MAX_LEN,
  toPublicResponse,
  truncate,
} from '../../../../src/scoreboard/shared/errors/to-public-response';

describe('truncate', () => {
  it('returns input unchanged when shorter than maxLen', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('appends "..." when truncated', () => {
    const input = 'a'.repeat(20);
    const out = truncate(input, 10);
    expect(out).toBe('a'.repeat(10) + '...');
  });
});

describe('toPublicResponse', () => {
  it('builds standard envelope for ValidationError with details', () => {
    const err = new ValidationError('delta out of range', [
      { field: 'delta' },
    ]);
    const result = toPublicResponse(err, 'req-123', null);
    expect(result.status).toBe(400);
    expect(result.body.error).toEqual({
      code: 'VALIDATION',
      message: 'delta out of range',
      requestId: 'req-123',
      details: [{ field: 'delta' }],
    });
    expect(result.body.error.errorId).toBeUndefined();
    expect(result.body.error.stack).toBeUndefined();
    expect(result.body.error.cause).toBeUndefined();
  });

  it('omits details for non-Validation errors', () => {
    const err = new ConflictError('duplicate');
    const result = toPublicResponse(err, 'req-1', null);
    expect(result.body.error.details).toBeUndefined();
  });

  it('omits details on ValidationError when none set', () => {
    const err = new ValidationError('bad');
    const result = toPublicResponse(err, 'req-1', null);
    expect(result.body.error.details).toBeUndefined();
  });

  it('replaces InternalError message with the generic', () => {
    const err = new InternalError('database password: hunter2');
    const result = toPublicResponse(err, 'req-1', 'err-uuid');
    expect(result.body.error.message).toBe('Internal server error');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.body.error.errorId).toBe('err-uuid');
  });

  it('truncates messages longer than 200 bytes with "..." suffix', () => {
    const longMessage = 'x'.repeat(500);
    const err = new ValidationError(longMessage);
    const result = toPublicResponse(err, 'req', null);
    const msg = result.body.error.message as string;
    expect(msg.length).toBe(MESSAGE_MAX_LEN + 3);
    expect(msg.endsWith('...')).toBe(true);
  });

  it('includes errorId only when caller passes non-null', () => {
    const err = new InternalError();
    const withId = toPublicResponse(err, 'r', 'err-1');
    const withoutId = toPublicResponse(err, 'r', null);
    expect(withId.body.error.errorId).toBe('err-1');
    expect(withoutId.body.error.errorId).toBeUndefined();
  });

  it('passes through requestId=null as null', () => {
    const err = new ForbiddenError('scope mismatch');
    const result = toPublicResponse(err, null, null);
    expect(result.body.error.requestId).toBeNull();
  });

  it('emits RATE_LIMIT code for RateLimitError (not RATE_LIMITED)', () => {
    const err = new RateLimitError('too many');
    const result = toPublicResponse(err, 'r', null);
    expect(result.body.error.code).toBe('RATE_LIMIT');
    expect(result.status).toBe(429);
  });
});
