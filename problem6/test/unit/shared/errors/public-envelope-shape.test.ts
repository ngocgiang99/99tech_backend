import {
  BadRequestError,
  InternalError,
  RateLimitError,
  ValidationError,
  toPublicResponse,
} from '../../../../src/scoreboard/shared/errors';

describe('Public envelope contract — regression tests', () => {
  describe('RATE_LIMITED → RATE_LIMIT code rename (design.md Decision 8)', () => {
    it('RateLimitError emits code "RATE_LIMIT", not "RATE_LIMITED"', () => {
      const err = new RateLimitError('too many');
      const { status, body } = toPublicResponse(err, 'req-1', null);
      expect(status).toBe(429);
      expect(body.error.code).toBe('RATE_LIMIT');
      expect(body.error.code).not.toBe('RATE_LIMITED');
    });
  });

  describe('No "hint" field in the envelope (removed from problem6 old filter)', () => {
    it('ValidationError envelope has no hint field', () => {
      const err = new ValidationError('bad delta');
      const { body } = toPublicResponse(err, 'req-1', null);
      expect(body.error.hint).toBeUndefined();
      expect('hint' in body.error).toBe(false);
    });

    it('InternalError envelope has no hint field', () => {
      const err = new InternalError('boom');
      const { body } = toPublicResponse(err, 'req-1', 'err-uuid');
      expect(body.error.hint).toBeUndefined();
      expect('hint' in body.error).toBe(false);
    });

    it('BadRequestError envelope has no hint field', () => {
      const err = new BadRequestError('bad');
      const { body } = toPublicResponse(err, 'req-1', null);
      expect('hint' in body.error).toBe(false);
    });
  });

  describe('Envelope key allowlist — nothing unexpected leaks', () => {
    it('a non-validation error produces exactly {code, message, requestId}', () => {
      const err = new BadRequestError('nope');
      const { body } = toPublicResponse(err, 'r', null);
      expect(Object.keys(body.error).sort()).toEqual([
        'code',
        'message',
        'requestId',
      ]);
    });

    it('a validation error produces {code, message, requestId, details}', () => {
      const err = new ValidationError('bad', [{ path: 'delta' }]);
      const { body } = toPublicResponse(err, 'r', null);
      expect(Object.keys(body.error).sort()).toEqual([
        'code',
        'details',
        'message',
        'requestId',
      ]);
    });

    it('a 500 emits {code, message, requestId, errorId}', () => {
      const err = new InternalError('boom');
      const { body } = toPublicResponse(err, 'r', 'err-1');
      expect(Object.keys(body.error).sort()).toEqual([
        'code',
        'errorId',
        'message',
        'requestId',
      ]);
    });
  });
});
