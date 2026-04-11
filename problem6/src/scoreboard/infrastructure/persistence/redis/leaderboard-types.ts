export const SCORE_SHIFT = 2 ** 32;

/**
 * Maximum value for `updatedAtSeconds` in encode/decode operations.
 * Equals `2^32 - 1` (the largest value that fits in the low 32 bits of the
 * encoded ZSET score).
 */
const MAX_TS = SCORE_SHIFT - 1;

/**
 * Encode a (score, updatedAtSeconds) pair into a single Redis ZSET score.
 *
 * Formula: `encoded = score * SCORE_SHIFT + (MAX_TS - updatedAtSeconds)`
 *
 * This keeps the encoded value within the range
 *   [score * SCORE_SHIFT, score * SCORE_SHIFT + MAX_TS]
 * — i.e., strictly within the "score bucket" — enabling lossless round-trip
 * decoding via `Math.floor(encoded / SCORE_SHIFT)`.
 *
 * Ordering guarantees (Redis ZREVRANGE returns highest score first):
 * - Higher `score` → higher encoded value → higher rank ✓
 * - Same `score`, lower `updatedAtSeconds` (earlier update) →
 *   larger `(MAX_TS - ts)` → higher encoded value → higher rank ✓
 *
 * Precision note: IEEE-754 float64 can represent at most 53 significant bits.
 * `score * SCORE_SHIFT` uses `ceil(log2(score)) + 32` bits; lossless round-trip
 * is guaranteed when `score * SCORE_SHIFT + SCORE_SHIFT <= Number.MAX_SAFE_INTEGER`,
 * i.e., when `score <= 2_097_151` (~2 M). At `score = 1_000_000_000` (the domain
 * cap) the encoded value exceeds `MAX_SAFE_INTEGER`, causing rounding errors.
 * For the leaderboard use-case the ORDERING remains correct; only the decoded
 * `updatedAtSeconds` may be approximate at extreme scores. This is documented
 * as a known limitation of ADR-16 / GAP-01 Option A.
 */
export function encodeScore(score: number, updatedAtSeconds: number): number {
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000_000) {
    throw new RangeError(
      `score must be an integer in [0, 1_000_000_000], received: ${score}`,
    );
  }
  if (
    !Number.isInteger(updatedAtSeconds) ||
    updatedAtSeconds < 0 ||
    updatedAtSeconds > MAX_TS
  ) {
    throw new RangeError(
      `updatedAtSeconds must be a non-negative integer <= ${MAX_TS}, received: ${updatedAtSeconds}`,
    );
  }
  return score * SCORE_SHIFT + (MAX_TS - updatedAtSeconds);
}

/**
 * Decode a Redis ZSET score back into (score, updatedAtSeconds).
 *
 * Inverse of encodeScore (exact within the lossless precision range):
 *   score = Math.floor(encoded / SCORE_SHIFT)
 *   updatedAtSeconds = MAX_TS - (encoded % SCORE_SHIFT)
 */
export function decodeScore(encoded: number): {
  score: number;
  updatedAtSeconds: number;
} {
  const score = Math.floor(encoded / SCORE_SHIFT);
  const updatedAtSeconds = MAX_TS - (encoded % SCORE_SHIFT);
  return { score, updatedAtSeconds };
}
