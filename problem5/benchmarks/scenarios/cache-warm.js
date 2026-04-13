/**
 * Cache-warm scenario — pre-warmed Redis.
 *
 * The setup() phase issues one GET /api/v1/resources/:id for every id in ids.json to
 * pre-populate the Redis cache before the measurement phase. The main load
 * then runs the same read-load workload as read-load.js but with the cache
 * fully warm — nearly all requests should return X-Cache: HIT.
 *
 * Compare the achieved RPS and p99 latency against cache-cold.js to quantify
 * the cache benefit on this hardware configuration.
 *
 * Run: pnpm bench:cache:warm
 */

import http from 'k6/http';
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
    cache_warm: {
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

/**
 * Pre-warm the Redis cache by fetching every id in the seed pool.
 * k6 runs setup() once before VUs start.
 */
export function setup() {
  const baseUrl = __ENV.BASE_URL ? __ENV.BASE_URL.replace(/\/$/, '') : 'http://localhost:3000';
  console.log(`[cache-warm] Pre-warming cache for ${ids.length} resources...`);

  let warmed = 0;
  for (const id of ids) {
    const res = http.get(`${baseUrl}/api/v1/resources/${id}`);
    if (res.status === 200) {
      warmed++;
    }
  }

  console.log(`[cache-warm] Cache warm-up complete: ${warmed}/${ids.length} resources loaded.`);
}

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
