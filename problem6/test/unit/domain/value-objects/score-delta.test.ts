import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import {
  MAX_DELTA,
  ScoreDelta,
} from '../../../../src/scoreboard/domain/value-objects/score-delta';

describe('ScoreDelta.of', () => {
  it('accepts a valid positive integer', () => {
    const d = ScoreDelta.of(50);
    expect(d.value).toBe(50);
  });

  it('accepts 1 (lower bound)', () => {
    expect(ScoreDelta.of(1).value).toBe(1);
  });

  it('accepts MAX_DELTA (upper bound)', () => {
    expect(ScoreDelta.of(MAX_DELTA).value).toBe(MAX_DELTA);
  });

  it('rejects 0', () => {
    expect(() => ScoreDelta.of(0)).toThrow(InvalidArgumentError);
  });

  it('rejects -1', () => {
    expect(() => ScoreDelta.of(-1)).toThrow(InvalidArgumentError);
  });

  it('rejects non-integer 2.5', () => {
    expect(() => ScoreDelta.of(2.5)).toThrow(InvalidArgumentError);
  });

  it('rejects NaN', () => {
    expect(() => ScoreDelta.of(Number.NaN)).toThrow(InvalidArgumentError);
  });

  it('rejects MAX_DELTA + 1', () => {
    expect(() => ScoreDelta.of(MAX_DELTA + 1)).toThrow(InvalidArgumentError);
  });

  it('rejects non-number (cast bypass)', () => {
    expect(() => ScoreDelta.of('5' as unknown as number)).toThrow(
      InvalidArgumentError,
    );
  });
});
