import { ActionId } from '../../../../src/scoreboard/domain/value-objects/action-id';
import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';

describe('ActionId.of', () => {
  it('accepts a valid UUID', () => {
    const id = ActionId.of('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(id.value).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
  });

  it('rejects "xyz"', () => {
    expect(() => ActionId.of('xyz')).toThrow(InvalidArgumentError);
  });

  it('rejects non-string cast bypass', () => {
    expect(() => ActionId.of(null as unknown as string)).toThrow(
      InvalidArgumentError,
    );
  });
});
