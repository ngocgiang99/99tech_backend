import {
  ERROR_CODES,
  ERROR_CODE_META,
  defaultMessageFor,
  errorStatusFor,
} from '../../../../src/scoreboard/shared/errors/error-codes';

describe('error-codes', () => {
  it('ERROR_CODES contains exactly the ten supported strings in order', () => {
    expect(ERROR_CODES).toEqual([
      'VALIDATION',
      'BAD_REQUEST',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'UNPROCESSABLE_ENTITY',
      'RATE_LIMIT',
      'TEMPORARILY_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]);
  });

  it('ERROR_CODE_META has a canonical status for every code', () => {
    expect(ERROR_CODE_META.VALIDATION.status).toBe(400);
    expect(ERROR_CODE_META.BAD_REQUEST.status).toBe(400);
    expect(ERROR_CODE_META.UNAUTHENTICATED.status).toBe(401);
    expect(ERROR_CODE_META.FORBIDDEN.status).toBe(403);
    expect(ERROR_CODE_META.NOT_FOUND.status).toBe(404);
    expect(ERROR_CODE_META.CONFLICT.status).toBe(409);
    expect(ERROR_CODE_META.UNPROCESSABLE_ENTITY.status).toBe(422);
    expect(ERROR_CODE_META.RATE_LIMIT.status).toBe(429);
    expect(ERROR_CODE_META.TEMPORARILY_UNAVAILABLE.status).toBe(503);
    expect(ERROR_CODE_META.INTERNAL_ERROR.status).toBe(500);
  });

  it('errorStatusFor reads the table', () => {
    expect(errorStatusFor('CONFLICT')).toBe(409);
    expect(errorStatusFor('INTERNAL_ERROR')).toBe(500);
  });

  it('defaultMessageFor reads the table', () => {
    expect(defaultMessageFor('VALIDATION')).toBe('Validation failed');
    expect(defaultMessageFor('INTERNAL_ERROR')).toBe('Internal server error');
  });
});
