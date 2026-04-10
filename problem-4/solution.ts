/**
 * sum_to_n: compute the sum of integers from 1 to n.
 * Assumes the result is always < Number.MAX_SAFE_INTEGER.
 *
 * Three distinct implementations follow, each with different time/space trade-offs.
 */

/**
 * Implementation A: Gauss Formula
 *
 * Uses the closed-form arithmetic series formula: n * (n + 1) / 2
 *
 * Time complexity:  O(1) — single arithmetic operation regardless of n
 * Space complexity: O(1) — no extra memory allocated
 *
 * Trade-off: fastest possible, but relies on mathematical insight.
 * Note: for negative n, returns the sum of integers from n to -1 (e.g. sum_to_n(-3) = -6).
 */
function sum_to_n_a(n: number): number {
  return (n * (n + 1)) / 2;
}

/**
 * Implementation B: Iterative Loop
 *
 * Accumulates the sum by incrementing a counter from 1 up to n.
 *
 * Time complexity:  O(n) — one addition per integer in [1..n]
 * Space complexity: O(1) — only two variables (i, sum) are held in memory
 *
 * Trade-off: linear time but no stack growth, making it safe for any n
 * within the MAX_SAFE_INTEGER constraint. Most straightforward to read.
 */
function sum_to_n_b(n: number): number {
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += i;
  }
  return sum;
}

/**
 * Implementation C: Recursive
 *
 * Decomposes the problem: sum(n) = n + sum(n - 1), with sum(0) = 0 as the base case.
 *
 * Time complexity:  O(n) — n recursive calls before reaching the base case
 * Space complexity: O(n) — each call frame is pushed onto the call stack until n = 0
 *
 * Trade-off: elegant and expressive, but carries O(n) stack space. JavaScript
 * engines typically allow ~10k–15k frames before a stack overflow, so this is
 * safe only for moderate n despite the MAX_SAFE_INTEGER output constraint.
 */
function sum_to_n_c(n: number): number {
  if (n <= 0) return 0;
  return n + sum_to_n_c(n - 1);
}

export { sum_to_n_a, sum_to_n_b, sum_to_n_c };
