import { InvalidArgumentError } from '../errors/invalid-argument.error';

/**
 * Maximum allowed score value.
 *
 * Capped at 1,000,000,000 (one billion) to preserve bit-pack precision in the
 * Redis ZSET leaderboard cache (ADR-16 / GAP-01 decision).
 *
 * The ZSET encodes `(score, last_updated_at)` as a single IEEE-754 double:
 *   `encoded = score * 2^32 - updated_at_seconds`
 *
 * A score above 2^31 (~2.1 billion) would overflow the upper 32 bits of the
 * double's 53-bit mantissa, causing silent tie-breaking errors.  1,000,000,000
 * leaves ~1.1 billion of headroom while remaining an easily understood limit.
 */
export const SCORE_MAX = 1_000_000_000;

export class Score {
  private constructor(public readonly value: number) {}

  static of(n: number): Score {
    if (typeof n !== 'number' || Number.isNaN(n)) {
      throw new InvalidArgumentError(
        `Score must be a number: received ${String(n)}`,
      );
    }
    if (!Number.isInteger(n)) {
      throw new InvalidArgumentError(`Score must be an integer: received ${n}`);
    }
    if (n < 0) {
      throw new InvalidArgumentError(
        `Score must be non-negative: received ${n}`,
      );
    }
    if (n > SCORE_MAX) {
      throw new InvalidArgumentError(
        `Score exceeds maximum allowed value of ${SCORE_MAX} (bit-pack precision cap): received ${n}`,
      );
    }
    return new Score(n);
  }
}
