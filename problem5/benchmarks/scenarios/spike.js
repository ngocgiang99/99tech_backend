/**
 * Spike scenario — sudden traffic surge.
 *
 * Arrival rate ramps from 1,000 to 10,000 RPS over 10 s, holds for 30 s,
 * then drops back to 1,000 RPS over 10 s. Measures how the service handles
 * a sudden surge without extended warm-up.
 *
 * Thresholds are loosened for this scenario:
 *   - Error rate < 5% (service may shed load under spike)
 *   - p99 latency < 1000 ms (longer tail acceptable during surge)
 *
 * Run: pnpm bench:spike
 */

import { SharedArray } from 'k6/data';
import { mergeThresholds } from '../lib/thresholds.js';
import { getResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

const ids = new SharedArray('ids', () => JSON.parse(open('../seed/ids.json')));

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 1000,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 3000,
      stages: [
        { duration: '10s', target: 10000 },
        { duration: '30s', target: 10000 },
        { duration: '10s', target: 1000 },
      ],
    },
  },
  thresholds: mergeThresholds({
    http_req_failed: ['rate<0.05'],
    'http_req_duration{expected_response:true}': ['p(99)<1000'],
  }),
};

export default function () {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const res = getResource(id);
  checkResponse(res, 200);
}
