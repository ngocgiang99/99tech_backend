/**
 * Shared threshold definitions for k6 benchmark scenarios.
 *
 * `defaultThresholds` reflects the service's target SLOs:
 *   - Error rate < 1%
 *   - p99 latency < 500 ms for successful responses
 *
 * Use `mergeThresholds(overrides)` to produce scenario-specific variants
 * (e.g. spike allows a higher error rate; smoke uses a looser p99).
 */

export const defaultThresholds = {
  http_req_failed: ['rate<0.01'],
  'http_req_duration{expected_response:true}': ['p(99)<500'],
};

/**
 * Merge scenario-specific threshold overrides into the defaults.
 *
 * Keys in `overrides` replace the corresponding default key.
 * Keys absent from `overrides` retain the default value.
 *
 * @param {Object} overrides - Threshold entries to override.
 * @returns {Object} Merged threshold object suitable for `export const options`.
 *
 * @example
 * // Loosen p99 to 1000 ms for smoke test
 * mergeThresholds({ 'http_req_duration{expected_response:true}': ['p(99)<1000'] })
 *
 * @example
 * // Allow 5% error rate during spike
 * mergeThresholds({ http_req_failed: ['rate<0.05'] })
 */
export function mergeThresholds(overrides = {}) {
  return { ...defaultThresholds, ...overrides };
}
