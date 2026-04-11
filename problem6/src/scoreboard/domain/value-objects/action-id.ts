import { InvalidArgumentError } from '../errors/invalid-argument.error';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ActionId {
  private constructor(public readonly value: string) {}

  static of(raw: string): ActionId {
    if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) {
      throw new InvalidArgumentError(
        `ActionId must be a valid UUID: received ${String(raw)}`,
      );
    }
    return new ActionId(raw);
  }
}
