import { DomainError } from '../../../../src/scoreboard/domain/errors/domain-error';
import { IdempotencyViolationError } from '../../../../src/scoreboard/domain/errors/idempotency-violation.error';

describe('IdempotencyViolationError', () => {
  it('carries the offending actionId and domain code', () => {
    const err = new IdempotencyViolationError('11111111-1111-1111-1111-111111111111');
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('IDEMPOTENCY_VIOLATION');
    expect(err.actionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(err.message).toContain('11111111-1111-1111-1111-111111111111');
  });
});
