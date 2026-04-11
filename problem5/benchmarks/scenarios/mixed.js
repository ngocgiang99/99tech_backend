/**
 * Mixed scenario — 95% reads, 5% writes.
 *
 * Ramping arrival rate peaking at ~1000 RPS (realistic for a co-located
 * laptop run where k6 and the API share CPU). Each iteration:
 *   95% → GET /resources/:id from the seed pool
 *    5% → 50/50 split between POST and PATCH
 *
 * Custom counters track X-Cache header values so the Benchmark.md can report
 * cache hit rate alongside the overall RPS and method breakdown.
 *
 * Run: pnpm bench:mixed
 */

import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { defaultThresholds } from '../lib/thresholds.js';
import { getResource, createResource, patchResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

const ids = new SharedArray('ids', () => JSON.parse(open('../seed/ids.json')));

const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const cacheBypass = new Counter('cache_bypass');

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { duration: '1m', target: 1000 },
        { duration: '3m', target: 1000 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: defaultThresholds,
};

function randomName() {
  return `mixed-${Math.random().toString(36).slice(2, 10)}`;
}

export default function () {
  const roll = Math.random();

  if (roll < 0.95) {
    // 95% reads
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
  } else if (roll < 0.975) {
    // ~2.5% POST
    const createRes = createResource({ name: randomName(), type: 'mixed-write' });
    checkResponse(createRes, 201);
  } else {
    // ~2.5% PATCH — target a random seed id (may already exist)
    const id = ids[Math.floor(Math.random() * ids.length)];
    const patchRes = patchResource(id, { name: randomName() });
    checkResponse(patchRes, 200);
  }
}
