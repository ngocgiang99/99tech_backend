/**
 * Write-load scenario — write throughput target.
 *
 * Constant arrival rate at 100 RPS for 2 minutes. Each iteration randomly
 * picks an operation:
 *   60% POST  — create a new resource
 *   30% PATCH — update the resource just created in this iteration
 *   10% DELETE — delete the resource just created in this iteration
 *
 * The id from the POST is scoped to the iteration so PATCH/DELETE always
 * target a resource that exists (avoids 404 noise in the error rate metric).
 *
 * Run: pnpm bench:write
 */

import { check } from 'k6';
import { defaultThresholds } from '../lib/thresholds.js';
import { createResource, patchResource, deleteResource } from '../lib/http.js';
import { checkResponse } from '../lib/checks.js';

export const options = {
  scenarios: {
    write_load: {
      executor: 'constant-arrival-rate',
      rate: 100,
      duration: '2m',
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: defaultThresholds,
};

function randomName() {
  return `bench-resource-${Math.random().toString(36).slice(2, 10)}`;
}

function randomType() {
  const types = ['widget', 'gadget', 'device', 'component', 'artifact'];
  return types[Math.floor(Math.random() * types.length)];
}

function randomTags() {
  const pool = ['bench', 'load-test', 'perf', 'k6', 'stress'];
  const count = Math.floor(Math.random() * 3) + 1;
  return pool.slice(0, count);
}

export default function () {
  const roll = Math.random();

  // Always create first so we have a valid id for PATCH/DELETE paths
  const createPayload = {
    name: randomName(),
    type: randomType(),
    tags: randomTags(),
  };

  const createRes = createResource(createPayload);
  const created = checkResponse(createRes, 201);

  if (!created) {
    // Creation failed — nothing to PATCH or DELETE
    return;
  }

  let createdId = null;
  try {
    createdId = JSON.parse(createRes.body).id;
  } catch (_) {
    return;
  }

  if (roll < 0.60) {
    // 60% — POST only (already done above)
  } else if (roll < 0.90) {
    // 30% — PATCH the just-created resource
    const patchRes = patchResource(createdId, { name: randomName(), status: 'updated' });
    checkResponse(patchRes, 200);
  } else {
    // 10% — DELETE the just-created resource
    const deleteRes = deleteResource(createdId);
    check(deleteRes, { 'delete status is 204': (r) => r.status === 204 });
  }
}
