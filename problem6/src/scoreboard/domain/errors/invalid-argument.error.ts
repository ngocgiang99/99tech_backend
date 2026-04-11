import { DomainError } from './domain-error';

export class InvalidArgumentError extends DomainError {
  readonly code = 'INVALID_ARGUMENT';
}
