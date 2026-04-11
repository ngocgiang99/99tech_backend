/**
 * Read-load scenario — GET throughput target.
 *
 * Ramps from 0 to 10,000 RPS over 1 min, holds for 3 min, then ramps down.
 * VUs draw from the pre-seeded ids.json pool via SharedArray so each request
 * targets a valid resource (enabling realistic cache hit rates).
 *
 * Custom counters track X-Cache header values (HIT / MISS / BYPASS) so the
 * benchmark summary shows cache efficiency alongside throughput.
 *
 * Run: pnpm bench:read
 */

import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { defaultThresholds } from '../lib/thresholds.js';
import { getResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

const ids = new SharedArray('ids', () => JSON.parse(open('../seed/ids.json')));

const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const cacheBypass = new Counter('cache_bypass');

export const options = {
  scenarios: {
    read_load: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { duration: '1m', target: 10000 },
        { duration: '3m', target: 10000 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: defaultThresholds,
};

export default function () {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const res = getResource(id);
  checkResponse(res, 200);

  const cacheHeader = res.headers['X-Cache'] || '';
  if (cacheHeader === 'HIT') {
    cacheHits.add(1);
  } else if (cacheHeader === 'MISS') {
    cacheMisses.add(1);
  } else if (cacheHeader === 'BYPASS') {
    cacheBypass.add(1);
  }
}
