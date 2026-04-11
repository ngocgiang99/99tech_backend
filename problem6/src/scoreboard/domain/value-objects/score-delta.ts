import { InvalidArgumentError } from '../errors/invalid-argument.error';

export const MAX_DELTA = 10000;

export class ScoreDelta {
  private constructor(public readonly value: number) {}

  static of(n: number): ScoreDelta {
    if (typeof n !== 'number' || Number.isNaN(n)) {
      throw new InvalidArgumentError(`ScoreDelta must be a number: received ${String(n)}`);
    }
    if (!Number.isInteger(n)) {
      throw new InvalidArgumentError(`ScoreDelta must be an integer: received ${n}`);
    }
    if (n < 1) {
      throw new InvalidArgumentError(`ScoreDelta must be >= 1: received ${n}`);
    }
    if (n > MAX_DELTA) {
      throw new InvalidArgumentError(`ScoreDelta must be <= ${MAX_DELTA}: received ${n}`);
    }
    return new ScoreDelta(n);
  }
}
