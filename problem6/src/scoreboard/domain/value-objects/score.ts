import { InvalidArgumentError } from '../errors/invalid-argument.error';

export class Score {
  private constructor(public readonly value: number) {}

  static of(n: number): Score {
    if (typeof n !== 'number' || Number.isNaN(n)) {
      throw new InvalidArgumentError(`Score must be a number: received ${String(n)}`);
    }
    if (!Number.isInteger(n)) {
      throw new InvalidArgumentError(`Score must be an integer: received ${n}`);
    }
    if (n < 0) {
      throw new InvalidArgumentError(`Score must be non-negative: received ${n}`);
    }
    if (n > Number.MAX_SAFE_INTEGER) {
      throw new InvalidArgumentError(`Score exceeds MAX_SAFE_INTEGER: received ${n}`);
    }
    return new Score(n);
  }
}
