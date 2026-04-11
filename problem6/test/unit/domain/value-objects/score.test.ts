import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import {
  Score,
  SCORE_MAX,
} from '../../../../src/scoreboard/domain/value-objects/score';

describe('Score.of', () => {
  it('accepts 0', () => {
    expect(Score.of(0).value).toBe(0);
  });

  it('accepts a positive integer', () => {
    expect(Score.of(42).value).toBe(42);
  });

  it('accepts the maximum allowed value (1_000_000_000)', () => {
    expect(Score.of(SCORE_MAX).value).toBe(1_000_000_000);
  });

  it('rejects negative', () => {
    expect(() => Score.of(-1)).toThrow(InvalidArgumentError);
  });

  it('rejects non-integer', () => {
    expect(() => Score.of(1.5)).toThrow(InvalidArgumentError);
  });

  it('rejects NaN', () => {
    expect(() => Score.of(Number.NaN)).toThrow(InvalidArgumentError);
  });

  it('rejects value above bit-pack cap (1_000_000_001)', () => {
    expect(() => Score.of(1_000_000_001)).toThrow(InvalidArgumentError);
  });

  it('rejects value above MAX_SAFE_INTEGER', () => {
    expect(() => Score.of(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects non-number cast bypass', () => {
    expect(() => Score.of('42' as unknown as number)).toThrow(
      InvalidArgumentError,
    );
  });
});
