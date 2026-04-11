/**
 * k6 load test — Scoreboard API
 *
 * Validates:
 *   - DECISION-2 thresholds (from architecture.md):
 *       p(99) < 150ms for POST /v1/scores:increment
 *       p(95) < 50ms  for GET  /v1/leaderboard/top
 *       p(95) < 1000ms for SSE event latency
 *
 * Scenarios:
 *   - writers: 20% of VUs do write operations (issue-token + scores:increment)
 *   - readers: 80% of VUs do read operations (leaderboard/top + SSE spot-check)
 *
 * Quick mode: Set env var K6_QUICK=1 for a shortened 1-minute run
 * (useful for local smoke tests).
 *
 * JWT: Built using k6's crypto module (HS256 HMAC-SHA256) from INTERNAL_JWT_SECRET env var.
 *
 * Run:
 *   k6 run test/load/scoreboard.k6.ts
 *   K6_QUICK=1 k6 run test/load/scoreboard.k6.ts
 *   k6 run --env K6_QUICK=1 test/load/scoreboard.k6.ts
 */

// @ts-nocheck — k6 uses its own non-Node runtime; TypeScript annotations for editor support only
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { randomUUID } from 'k6/crypto';
import { b64encode } from 'k6/encoding';

// ─── Custom metrics ────────────────────────────────────────────────────────────
const sseEventLatency = new Trend('sse_event_latency', true);

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const INTERNAL_JWT_SECRET = __ENV.INTERNAL_JWT_SECRET || '8345613e20737ef44370435a1a94961bbcabf31177f554305c1499a553cf7c86';
const QUICK = __ENV.K6_QUICK === '1';

// ─── Options ──────────────────────────────────────────────────────────────────

export const options = {
  thresholds: {
    // DECISION-2 thresholds — FIXED, do not tighten
    'http_req_duration{endpoint:scores_increment}': ['p(99)<150'],
    'http_req_duration{endpoint:leaderboard_top}': ['p(95)<50'],
    'sse_event_latency': ['p(95)<1000'],
  },

  scenarios: QUICK
    ? {
        // Quick mode: 1-minute total, low VU count for local smoke
        writers_quick: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '15s', target: 5 },
            { duration: '30s', target: 5 },
            { duration: '15s', target: 0 },
          ],
          exec: 'writerScenario',
          tags: { scenario: 'writers_quick' },
        },
        readers_quick: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '15s', target: 10 },
            { duration: '30s', target: 10 },
            { duration: '15s', target: 0 },
          ],
          exec: 'readerScenario',
          tags: { scenario: 'readers_quick' },
        },
      }
    : {
        // Full mode: ramp 0→10000 VUs over 5min, hold 30min, ramp-down 5min
        writers: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '5m', target: 2000 },  // 20% writers of 10000 total
            { duration: '30m', target: 2000 },
            { duration: '5m', target: 0 },
          ],
          exec: 'writerScenario',
          tags: { scenario: 'writers' },
        },
        readers: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '5m', target: 8000 },  // 80% readers of 10000 total
            { duration: '30m', target: 8000 },
            { duration: '5m', target: 0 },
          ],
          exec: 'readerScenario',
          tags: { scenario: 'readers' },
        },
      },
};

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Build a HS256 JWT using k6's built-in crypto module.
 * k6 does not have node:crypto or jose — uses k6/crypto hmac().
 */
function buildJwt(userId) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    iat: now,
    exp: now + 3600, // 1h
  };

  const headerB64 = b64encode(JSON.stringify(header), 'rawurl');
  const payloadB64 = b64encode(JSON.stringify(payload), 'rawurl');
  const signingInput = `${headerB64}.${payloadB64}`;

  // k6/crypto hmac returns hex by default; we need raw bytes → base64url
  // Use the 'base64rawurl' encoding parameter
  const { hmac } = require('k6/crypto');
  const sigHex = hmac('sha256', INTERNAL_JWT_SECRET, signingInput, 'hex');

  // Convert hex string to base64url
  // k6 does not have Buffer — use ArrayBuffer via typed arrays
  const bytes = new Uint8Array(sigHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  }
  const sigB64 = b64encode(bytes.buffer, 'rawurl');

  return `${signingInput}.${sigB64}`;
}

// Per-VU JWT cached at init time
let _jwt = null;
let _userId = null;

function getJwt() {
  if (!_jwt) {
    _userId = `k6-vu-${__VU}-${Date.now()}`;
    _jwt = buildJwt(_userId);
  }
  return _jwt;
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

/**
 * Writer scenario: issue-token → scores:increment
 */
export function writerScenario() {
  const jwt = getJwt();
  const authHeader = { authorization: `Bearer ${jwt}` };

  // Issue action token
  const issueRes = http.post(
    `${BASE_URL}/v1/actions:issue-token`,
    JSON.stringify({ actionType: 'level-complete' }),
    {
      headers: { ...authHeader, 'content-type': 'application/json' },
      tags: { endpoint: 'issue_token' },
    },
  );

  const issueOk = check(issueRes, {
    'issue-token: status 200': (r) => r.status === 200,
    'issue-token: has actionToken': (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.actionToken === 'string';
      } catch {
        return false;
      }
    },
  });

  if (!issueOk) {
    sleep(0.5);
    return;
  }

  const { actionId, actionToken } = JSON.parse(issueRes.body);

  // Increment score
  const writeTs = Date.now();
  const incrementRes = http.post(
    `${BASE_URL}/v1/scores:increment`,
    JSON.stringify({ actionId, delta: 10 }),
    {
      headers: {
        ...authHeader,
        'x-action-token': actionToken,
        'content-type': 'application/json',
      },
      tags: { endpoint: 'scores_increment' },
    },
  );

  check(incrementRes, {
    'scores:increment: status 200': (r) => r.status === 200,
    'scores:increment: has newScore': (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.newScore === 'number';
      } catch {
        return false;
      }
    },
  });

  // SSE spot-check: open a 5-second SSE connection and record latency to first event
  const sseConnectTs = Date.now();
  const sseRes = http.get(`${BASE_URL}/v1/leaderboard/stream`, {
    headers: authHeader,
    tags: { endpoint: 'sse_stream' },
    timeout: '6s',
    // responseType: 'text' — k6 reads the first chunk of an SSE response
  });

  if (sseRes.status === 200 && sseRes.body) {
    // Record latency from write to first SSE event received
    const frames = sseRes.body.split('\n\n').filter((b) => b.includes('event:'));
    if (frames.length > 0) {
      sseEventLatency.add(Date.now() - writeTs);
    }
  }

  sleep(1);
}

/**
 * Reader scenario: GET /v1/leaderboard/top
 */
export function readerScenario() {
  const jwt = getJwt();
  const authHeader = { authorization: `Bearer ${jwt}` };

  const topRes = http.get(`${BASE_URL}/v1/leaderboard/top?limit=10`, {
    headers: authHeader,
    tags: { endpoint: 'leaderboard_top' },
  });

  check(topRes, {
    'leaderboard/top: status 200': (r) => r.status === 200,
    'leaderboard/top: has entries': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.entries);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}

// ─── Default function (required by k6) ────────────────────────────────────────

export default function () {
  // The default function is not used — scenarios specify their own exec functions.
  // This satisfies k6's requirement for a default export in case someone runs
  // without scenario config.
  readerScenario();
}
