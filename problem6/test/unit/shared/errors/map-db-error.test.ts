import {
  ConflictError,
  DependencyUnavailableError,
  InternalError,
  ValidationError,
} from '../../../../src/scoreboard/shared/errors/domain-error';
import {
  isPgError,
  mapDbError,
} from '../../../../src/scoreboard/shared/errors/map-db-error';

function pgErr(
  code: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { code, name: 'error', message: `pg error ${code}`, ...extra };
}

describe('isPgError', () => {
  it('recognises an object with string code and name=error', () => {
    expect(isPgError(pgErr('23505'))).toBe(true);
  });

  it('recognises name=DatabaseError', () => {
    expect(isPgError({ code: '23505', name: 'DatabaseError' })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isPgError('string')).toBe(false);
    expect(isPgError(null)).toBe(false);
    expect(isPgError(undefined)).toBe(false);
    expect(isPgError(42)).toBe(false);
  });

  it('rejects objects without a string code', () => {
    expect(isPgError({ name: 'error' })).toBe(false);
    expect(isPgError({ code: 23505, name: 'error' })).toBe(false);
  });

  it('rejects objects with wrong name', () => {
    expect(isPgError({ code: '23505', name: 'TypeError' })).toBe(false);
  });
});

describe('mapDbError — SQLSTATE routing', () => {
  it('23505 → ConflictError with pgCode attached', () => {
    const err = pgErr('23505', { detail: 'Key (user_id)=(u1) already exists' });
    const mapped = mapDbError(err);
    expect(mapped).toBeInstanceOf(ConflictError);
    expect((mapped as { pgCode?: string }).pgCode).toBe('23505');
    expect(mapped.cause).toBe(err);
  });

  it('23502 → ValidationError with column in details', () => {
    const err = pgErr('23502', { column: 'user_id' });
    const mapped = mapDbError(err);
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.details).toEqual({ column: 'user_id' });
    expect((mapped as { pgCode?: string }).pgCode).toBe('23502');
  });

  it('23503 → ValidationError', () => {
    const mapped = mapDbError(pgErr('23503'));
    expect(mapped).toBeInstanceOf(ValidationError);
    expect((mapped as { pgCode?: string }).pgCode).toBe('23503');
  });

  it('22001 → ValidationError', () => {
    const mapped = mapDbError(pgErr('22001'));
    expect(mapped).toBeInstanceOf(ValidationError);
    expect((mapped as { pgCode?: string }).pgCode).toBe('22001');
  });

  it('40P01 → DependencyUnavailableError', () => {
    const mapped = mapDbError(pgErr('40P01'));
    expect(mapped).toBeInstanceOf(DependencyUnavailableError);
    expect(mapped.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect((mapped as { pgCode?: string }).pgCode).toBe('40P01');
  });

  it('57014 → DependencyUnavailableError', () => {
    const mapped = mapDbError(pgErr('57014'));
    expect(mapped).toBeInstanceOf(DependencyUnavailableError);
    expect((mapped as { pgCode?: string }).pgCode).toBe('57014');
  });

  it('53300 → DependencyUnavailableError', () => {
    const mapped = mapDbError(pgErr('53300'));
    expect(mapped).toBeInstanceOf(DependencyUnavailableError);
    expect((mapped as { pgCode?: string }).pgCode).toBe('53300');
  });

  it('unknown pg code falls through to InternalError', () => {
    const err = pgErr('XX999', { message: 'strange' });
    const mapped = mapDbError(err);
    expect(mapped).toBeInstanceOf(InternalError);
    expect((mapped as { pgCode?: string }).pgCode).toBe('XX999');
    expect(mapped.cause).toBe(err);
  });

  it('non-pg value → InternalError with original as cause', () => {
    const mapped = mapDbError('something went wrong');
    expect(mapped).toBeInstanceOf(InternalError);
    expect(mapped.cause).toBe('something went wrong');
    expect((mapped as { pgCode?: string }).pgCode).toBeUndefined();
  });

  it('uses default message when pg error has empty message — 23505', () => {
    const mapped = mapDbError({ code: '23505', name: 'error', message: '' });
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped.message).toBe('Unique constraint violation');
  });

  it('uses default message when pg error has empty message — 23502', () => {
    const mapped = mapDbError({ code: '23502', name: 'error', message: '' });
    expect(mapped.message).toBe('Not-null constraint violation');
  });

  it('uses default message when pg error has empty message — 23503', () => {
    const mapped = mapDbError({ code: '23503', name: 'error', message: '' });
    expect(mapped.message).toBe('Foreign key constraint violation');
  });

  it('uses default message when pg error has empty message — 22001', () => {
    const mapped = mapDbError({ code: '22001', name: 'error', message: '' });
    expect(mapped.message).toBe('Value too long for column type');
  });

  it('uses default message when pg error has empty message — 40P01', () => {
    const mapped = mapDbError({ code: '40P01', name: 'error', message: '' });
    expect(mapped.message).toBe('Deadlock detected');
  });

  it('uses default message when pg error has empty message — 57014', () => {
    const mapped = mapDbError({ code: '57014', name: 'error', message: '' });
    expect(mapped.message).toBe('Query cancelled');
  });

  it('uses default message when pg error has empty message — 53300', () => {
    const mapped = mapDbError({ code: '53300', name: 'error', message: '' });
    expect(mapped.message).toBe('Too many database connections');
  });

  it('23502 without column produces no column detail', () => {
    const mapped = mapDbError({ code: '23502', name: 'error', message: 'x' });
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.details).toBeUndefined();
  });

  it('pgCode is non-enumerable (not visible in JSON.stringify key set)', () => {
    const mapped = mapDbError({ code: '23505', name: 'error', message: 'x' });
    const serialised = JSON.stringify(mapped);
    // The literal "pgCode" property name must never appear in the serialised
    // payload; the raw SQLSTATE may still appear inside the preserved `cause`
    // (that's fine — metadata builder reads pgCode from the attached property).
    expect(serialised).not.toContain('pgCode');
    expect(Object.getOwnPropertyDescriptor(mapped, 'pgCode')?.enumerable).toBe(
      false,
    );
  });
});
