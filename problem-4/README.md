# Problem 4 — sum_to_n

Three implementations of `sum_to_n(n)` (Gauss formula, iterative loop, recursive)
and a test suite covering correctness, edge cases, the `MAX_SAFE_INTEGER`
boundary, negative-n divergence between the three variants, and the recursive
stack-overflow limit.

## Files

- `solution.ts` — the three implementations (`sum_to_n_a`, `sum_to_n_b`, `sum_to_n_c`)
- `solution.test.ts` — test suite using Node's built-in test runner

## Requirements

- Node.js **≥ 18** (for the built-in `node:test` module)
- `npx` (ships with npm)

No `package.json`, no install step. `tsx` is fetched on demand by `npx`.

## Run the tests

From the `problem-4/` directory:

```bash
npx tsx --test solution.test.ts
```

Expected output ends with:

```
ℹ tests 37
ℹ pass 37
ℹ fail 0
```

## Run a single implementation

```bash
npx tsx -e "import('./solution.ts').then(m => console.log(m.sum_to_n_a(100)))"
```
