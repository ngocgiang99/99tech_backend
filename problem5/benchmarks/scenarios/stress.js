/**
 * Stress scenario — find the breaking point.
 *
 * Arrival rate steps up by 1,000 RPS every 60 s until the service saturates.
 * Thresholds are intentionally very loose (p99 < 5 s, error rate < 50%) so
 * k6 continues running and records the saturation point rather than aborting
 * early. Benchmark.md should document the RPS at which errors first appear
 * and the RPS at which p99 latency first exceeds 500 ms.
 *
 * Run: pnpm bench:stress
 */

import { SharedArray } from 'k6/data';
import { mergeThresholds } from '../lib/thresholds.js';
import { getResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

const ids = new SharedArray('ids', () => JSON.parse(open('../seed/ids.json')));

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 500,
      maxVUs: 5000,
      stages: [
        { duration: '60s', target: 1000 },
        { duration: '60s', target: 2000 },
        { duration: '60s', target: 3000 },
        { duration: '60s', target: 4000 },
        { duration: '60s', target: 5000 },
        { duration: '60s', target: 6000 },
        { duration: '60s', target: 7000 },
        { duration: '60s', target: 8000 },
        { duration: '60s', target: 9000 },
        { duration: '60s', target: 10000 },
      ],
    },
  },
  thresholds: mergeThresholds({
    http_req_failed: ['rate<0.5'],
    'http_req_duration{expected_response:true}': ['p(99)<5000'],
  }),
};

export default function () {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const res = getResource(id);
  checkResponse(res, 200);
}
