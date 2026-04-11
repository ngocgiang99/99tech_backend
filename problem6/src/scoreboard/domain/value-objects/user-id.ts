import { InvalidArgumentError } from '../errors/invalid-argument.error';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UserId {
  private constructor(public readonly value: string) {}

  static of(raw: string): UserId {
    if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) {
      throw new InvalidArgumentError(`UserId must be a valid UUID: received ${String(raw)}`);
    }
    return new UserId(raw);
  }
}
