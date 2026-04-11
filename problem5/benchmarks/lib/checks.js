/**
 * k6 check helpers for benchmark scenarios.
 *
 * Centralises the check logic so all scenarios apply the same assertions and
 * the same failure logging format. k6's `check()` increments pass/fail
 * counters in the summary; `checkResponse` wraps it with a status assertion
 * and a console.error on unexpected responses.
 */

import { check } from 'k6';

/**
 * Assert that a response has the expected HTTP status code.
 *
 * Increments k6's built-in check counters (`checks` metric).
 * Logs details to stderr when the assertion fails so reviewers can diagnose
 * failures in the k6 summary output.
 *
 * @param {import('k6/http').RefinedResponse<'text'>} res - k6 HTTP response
 * @param {number} expectedStatus - Expected HTTP status code (e.g. 200, 201)
 * @returns {boolean} true if the check passed, false otherwise
 *
 * @example
 * const res = getResource(id);
 * checkResponse(res, 200);
 *
 * @example
 * const res = createResource({ name: 'x', type: 'y' });
 * checkResponse(res, 201);
 */
export function checkResponse(res, expectedStatus) {
  const passed = check(res, {
    [`status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
  });

  if (!passed) {
    console.error(
      `check failed — expected ${expectedStatus}, got ${res.status} | url=${res.url} | body=${res.body}`,
    );
  }

  return passed;
}
