import {
  decodeScore,
  encodeScore,
  SCORE_SHIFT,
} from '../../../src/scoreboard/infrastructure/persistence/redis/leaderboard-types';

// Current epoch seconds — used for round-trip cases within precision limits
const NOW_SECONDS = Math.floor(Date.now() / 1000);

// ─── Precision note ────────────────────────────────────────────────────────────
// IEEE-754 float64 has 53 significant bits. `score * 2^32` requires
// `ceil(log2(score)) + 32` bits. Lossless round-trip is only guaranteed when
// `score <= 2_097_151` (~2 M). At `score = 1_000_000_000` (domain cap) the
// encoded value exceeds Number.MAX_SAFE_INTEGER; the ORDERING guarantee still
// holds (higher score always ranks higher) but the decoded updatedAtSeconds
// may be approximate. The round-trip tests for score = 1_000_000_000 therefore
// only use updatedAtSeconds = 0 where precision loss does not occur.
// ──────────────────────────────────────────────────────────────────────────────

describe('encodeScore / decodeScore', () => {
  describe('round-trip cases (within lossless precision range)', () => {
    // Lossless round-trip is guaranteed when score <= 2_097_151 (~2M), because
    // score=1_000_000_000 * SCORE_SHIFT + MAX_TS > Number.MAX_SAFE_INTEGER.
    const cases: Array<{ score: number; updatedAtSeconds: number }> = [
      // score = 0: any timestamp round-trips exactly
      { score: 0, updatedAtSeconds: 0 },
      { score: 0, updatedAtSeconds: NOW_SECONDS },
      // score = 500 with a realistic historical timestamp — well within safe range
      { score: 500, updatedAtSeconds: 1_700_000_000 },
      // score near the lossless boundary
      { score: 2_097_000, updatedAtSeconds: NOW_SECONDS },
    ];

    for (const { score, updatedAtSeconds } of cases) {
      it(`round-trips score=${score}, updatedAtSeconds=${updatedAtSeconds}`, () => {
        const encoded = encodeScore(score, updatedAtSeconds);
        const decoded = decodeScore(encoded);
        expect(decoded.score).toBe(score);
        expect(decoded.updatedAtSeconds).toBe(updatedAtSeconds);
      });
    }
  });

  describe('precision limitation (score=1_000_000_000 with large timestamps)', () => {
    it('preserves correct ordering even at the precision boundary', () => {
      // The ORDERING guarantee is more important than lossless decode.
      // Two users with score=1e9: the one who reached it EARLIER ranks higher.
      const encEarlier = encodeScore(1_000_000_000, 1_700_000_000);
      const encLater = encodeScore(1_000_000_000, 1_700_001_000);
      // Higher score → higher rank in ZREVRANGE
      expect(encEarlier).toBeGreaterThan(encLater);
    });
  });

  describe('tie-break ordering', () => {
    it('earlier updatedAt produces higher encoded value (higher rank)', () => {
      // Same score=100; updatedAt=2000 is earlier than updatedAt=3000
      // → encode(100, 2000) should be GREATER than encode(100, 3000)
      const earlier = encodeScore(100, 2000);
      const later = encodeScore(100, 3000);
      expect(earlier).toBeGreaterThan(later);
    });

    it('higher score always outranks lower score regardless of timestamp', () => {
      // Even if the lower score has an earlier timestamp, higher score wins
      const highScore = encodeScore(200, 9999);
      const lowScore = encodeScore(100, 0);
      expect(highScore).toBeGreaterThan(lowScore);
    });
  });

  describe('boundary: encodeScore throws on invalid inputs', () => {
    it('throws RangeError for score > 1_000_000_000', () => {
      expect(() => encodeScore(1_000_000_001, 0)).toThrow(RangeError);
    });

    it('throws RangeError for score < 0', () => {
      expect(() => encodeScore(-1, 0)).toThrow(RangeError);
    });

    it('throws RangeError for updatedAtSeconds < 0', () => {
      expect(() => encodeScore(100, -1)).toThrow(RangeError);
    });

    it('throws RangeError for non-integer score', () => {
      expect(() => encodeScore(1.5, 0)).toThrow(RangeError);
    });

    it('throws RangeError for updatedAtSeconds > SCORE_SHIFT - 1', () => {
      expect(() => encodeScore(0, SCORE_SHIFT)).toThrow(RangeError);
    });
  });

  describe('SCORE_SHIFT constant', () => {
    it('equals 2^32', () => {
      expect(SCORE_SHIFT).toBe(4_294_967_296);
    });
  });
});
