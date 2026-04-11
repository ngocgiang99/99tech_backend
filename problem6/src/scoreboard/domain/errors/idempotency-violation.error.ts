import { DomainError } from './domain-error';

export class IdempotencyViolationError extends DomainError {
  readonly code = 'IDEMPOTENCY_VIOLATION';

  constructor(public readonly actionId: string) {
    super(`actionId ${actionId} was already applied`);
  }
}
