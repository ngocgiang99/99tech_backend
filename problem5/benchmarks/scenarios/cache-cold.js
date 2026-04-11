/**
 * Cache-cold scenario — Postgres-only baseline.
 *
 * Runs the same read-load workload as read-load.js but with Redis flushed and
 * CACHE_ENABLED=false so every request hits Postgres directly. This establishes
 * the baseline without caching for comparison with cache-warm.js.
 *
 * HOW TO RUN:
 *   1. pnpm bench:flush-cache   — flush Redis (FLUSHDB)
 *   2. Stop the API and restart with CACHE_ENABLED=false:
 *        CACHE_ENABLED=false mise run dev
 *      or via Docker:
 *        docker compose down api && CACHE_ENABLED=false docker compose up -d api
 *   3. pnpm bench:cache:cold
 *
 * Run: pnpm bench:cache:cold
 */

import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { defaultThresholds } from '../lib/thresholds.js';
import { getResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

const ids = new SharedArray('ids', () => JSON.parse(open('../seed/ids.json')));

// Track cache headers even in cold mode to confirm BYPASS is reported
const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const cacheBypass = new Counter('cache_bypass');

export const options = {
  scenarios: {
    cache_cold: {
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

export function setup() {
  // The actual cache flush is done via `pnpm bench:flush-cache` before this
  // script runs. k6 setup() cannot invoke Node processes, so we just log a
  // reminder here. If X-Cache values other than BYPASS appear in the summary
  // the pre-run flush step was skipped.
  console.log(
    '[cache-cold] Reminder: ensure Redis was flushed and CACHE_ENABLED=false before this run.',
  );
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
