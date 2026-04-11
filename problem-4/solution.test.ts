import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sum_to_n_a, sum_to_n_b, sum_to_n_c } from "./solution";

const KNOWN_VALUES: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 3],
  [3, 6],
  [5, 15],
  [10, 55],
  [100, 5050],
  [1000, 500500],
];

describe("sum_to_n — correctness on known values", () => {
  for (const [n, expected] of KNOWN_VALUES) {
    it(`sum_to_n_a(${n}) === ${expected}`, () => {
      assert.equal(sum_to_n_a(n), expected);
    });
    it(`sum_to_n_b(${n}) === ${expected}`, () => {
      assert.equal(sum_to_n_b(n), expected);
    });
    it(`sum_to_n_c(${n}) === ${expected}`, () => {
      assert.equal(sum_to_n_c(n), expected);
    });
  }
});

describe("sum_to_n — edge case n = 0", () => {
  it("sum_to_n_a(0) === 0", () => {
    assert.equal(sum_to_n_a(0), 0);
  });
  it("sum_to_n_b(0) === 0", () => {
    assert.equal(sum_to_n_b(0), 0);
  });
  it("sum_to_n_c(0) === 0", () => {
    assert.equal(sum_to_n_c(0), 0);
  });
});

describe("sum_to_n — implementations agree on large n", () => {
  // 1,000,000 is large enough to exercise the loop but small enough to stay fast.
  // sum = 500_000_500_000, well under MAX_SAFE_INTEGER (≈ 9.0e15).
  const N = 1_000_000;
  const expected = (N * (N + 1)) / 2;

  it(`sum_to_n_a(${N}) matches the closed form`, () => {
    assert.equal(sum_to_n_a(N), expected);
  });
  it(`sum_to_n_b(${N}) matches sum_to_n_a`, () => {
    assert.equal(sum_to_n_b(N), expected);
  });
});

describe("sum_to_n — boundary near MAX_SAFE_INTEGER", () => {
  // n*(n+1)/2 stays an exact safe integer at this scale.
  // 94_906_265 * 94_906_266 / 2 = 4_503_599_615_578_245 < 2^53 - 1.
  const N = 94_906_265;
  const expected = 4_503_599_615_578_245;

  it("sum_to_n_a stays exact at the safe-integer boundary", () => {
    const result = sum_to_n_a(N);
    assert.equal(result, expected);
    assert.ok(Number.isSafeInteger(result));
  });

  // Skipping sum_to_n_b at this scale: the loop is correct but would take
  // tens of seconds. Skipping sum_to_n_c entirely: it would stack-overflow
  // long before reaching this n (covered explicitly below).
});

describe("sum_to_n — divergence on negative n", () => {
  // Note: the doc comment on sum_to_n_a claims "sum_to_n(-3) = -6", but the
  // actual formula n*(n+1)/2 produces (-3 * -2)/2 = 3, not -6. These tests
  // pin the real behavior of the implementation, not the doc's claim.
  it("sum_to_n_a(-3) === 3 (formula yields (-3*-2)/2)", () => {
    assert.equal(sum_to_n_a(-3), 3);
  });
  it("sum_to_n_a(-1) === -0 (formula yields -1*0/2, signed zero)", () => {
    // Strict equal distinguishes -0 from 0; Object.is is the only way to test it.
    assert.ok(Object.is(sum_to_n_a(-1), -0));
  });
  it("sum_to_n_a(-100) === 4950 (formula yields (-100*-99)/2)", () => {
    assert.equal(sum_to_n_a(-100), 4950);
  });

  // The loop never enters when n < 1, so it returns 0 — diverges from _a.
  it("sum_to_n_b(-3) === 0 (loop never enters)", () => {
    assert.equal(sum_to_n_b(-3), 0);
  });
  it("sum_to_n_b(-100) === 0", () => {
    assert.equal(sum_to_n_b(-100), 0);
  });

  // The recursive base case `n <= 0` short-circuits — also diverges from _a.
  it("sum_to_n_c(-3) === 0 (base case short-circuits)", () => {
    assert.equal(sum_to_n_c(-3), 0);
  });
  it("sum_to_n_c(-100) === 0", () => {
    assert.equal(sum_to_n_c(-100), 0);
  });
});

describe("sum_to_n — recursive stack limit (sum_to_n_c only)", () => {
  // Per the doc: V8 typically allows ~10k–15k frames. 100_000 is comfortably
  // past that limit, so this call must throw RangeError.
  it("sum_to_n_c(100_000) throws RangeError from stack overflow", () => {
    assert.throws(() => sum_to_n_c(100_000), RangeError);
  });

  // The other two implementations handle the same n with no trouble.
  it("sum_to_n_a(100_000) returns 5_000_050_000", () => {
    assert.equal(sum_to_n_a(100_000), 5_000_050_000);
  });
  it("sum_to_n_b(100_000) returns 5_000_050_000", () => {
    assert.equal(sum_to_n_b(100_000), 5_000_050_000);
  });
});
