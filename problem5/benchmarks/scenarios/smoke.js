/**
 * Smoke scenario — service alive under minimal load.
 *
 * 1 VU runs for 30 s, checks that /healthz responds 200 and that a single
 * GET /api/v1/resources/:id from the seed pool also responds 200.
 *
 * Thresholds are intentionally loosened (p99 < 1000 ms) relative to the
 * production SLO (500 ms) because a cold-start laptop run should still pass.
 *
 * Run: pnpm bench:smoke
 */

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { mergeThresholds } from '../lib/thresholds.js';
import { getResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

const ids = new SharedArray('ids', () => JSON.parse(open('../seed/ids.json')));

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
    },
  },
  thresholds: mergeThresholds({
    'http_req_duration{expected_response:true}': ['p(99)<1000'],
  }),
};

export default function () {
  // Check health endpoint
  const healthRes = http.get(`${__ENV.BASE_URL || 'http://localhost:3000'}/healthz`);
  check(healthRes, { 'healthz status is 200': (r) => r.status === 200 });

  // Check a resource from the seed pool
  const id = ids[0];
  const res = getResource(id);
  checkResponse(res, 200);
}
