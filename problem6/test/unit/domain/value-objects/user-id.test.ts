import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import { UserId } from '../../../../src/scoreboard/domain/value-objects/user-id';

describe('UserId.of', () => {
  it('accepts a valid lowercase UUID', () => {
    const id = UserId.of('550e8400-e29b-41d4-a716-446655440000');
    expect(id.value).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts a valid uppercase UUID', () => {
    const id = UserId.of('550E8400-E29B-41D4-A716-446655440000');
    expect(id.value).toBe('550E8400-E29B-41D4-A716-446655440000');
  });

  it('rejects non-UUID strings', () => {
    expect(() => UserId.of('not-a-uuid')).toThrow(InvalidArgumentError);
  });

  it('rejects the empty string', () => {
    expect(() => UserId.of('')).toThrow(InvalidArgumentError);
  });

  it('rejects non-string cast bypass', () => {
    expect(() => UserId.of(123 as unknown as string)).toThrow(
      InvalidArgumentError,
    );
  });
});
