import { Counter, Gauge, Histogram } from 'prom-client';

import { registry } from './registry';

/**
 * Metric tokens — use these string constants when providing / injecting via NestJS DI.
 */
export const METRIC_HTTP_REQUESTS_TOTAL =
  'metric.scoreboard_http_requests_total';
export const METRIC_HTTP_REQUEST_DURATION_SECONDS =
  'metric.scoreboard_http_request_duration_seconds';
export const METRIC_SCORE_INCREMENT_TOTAL =
  'metric.scoreboard_score_increment_total';
export const METRIC_ACTION_TOKEN_VERIFY_TOTAL =
  'metric.scoreboard_action_token_verify_total';
export const METRIC_RATE_LIMIT_HITS_TOTAL =
  'metric.scoreboard_rate_limit_hits_total';
export const METRIC_PROCESS_START_TIME_SECONDS =
  'metric.scoreboard_process_start_time_seconds';
export const METRIC_RATE_LIMIT_FAILED_CLOSED_TOTAL =
  'metric.scoreboard_rate_limit_failed_closed_total';

/**
 * HTTP request counter — incremented per completed request.
 * Labels: method (GET/POST/…), route (normalized, e.g. /v1/scores:increment), status (HTTP status code string)
 */
export const httpRequestsTotal = new Counter({
  name: 'scoreboard_http_requests_total',
  help: 'Total number of HTTP requests processed by the scoreboard service',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

/**
 * HTTP request duration histogram — observed per completed request.
 * Labels: method, route
 * Buckets: prom-client defaults (ms latency buckets in seconds: 5ms … 10s)
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'scoreboard_http_request_duration_seconds',
  help: 'HTTP request duration in seconds for the scoreboard service',
  labelNames: ['method', 'route'] as const,
  registers: [registry],
});

/**
 * Score increment counter — tracks write-path outcomes.
 * Labels: result — 'committed' (new credit applied), 'idempotent' (duplicate replayed), 'rejected' (TODO: wired by global error filter in a follow-up)
 */
export const scoreIncrementTotal = new Counter({
  name: 'scoreboard_score_increment_total',
  help: 'Total score increment attempts by result (committed|idempotent|rejected)',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Action token verification counter.
 * Labels: outcome — 'ok' (valid, not consumed), 'invalid' (bad signature/claims), 'consumed' (already used)
 */
export const actionTokenVerifyTotal = new Counter({
  name: 'scoreboard_action_token_verify_total',
  help: 'Total action token verifications by outcome (ok|invalid|consumed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Rate limit hits counter.
 * Labels: outcome — 'allowed' (request passed), 'rejected' (429), 'circuit_open' (503 global circuit breaker)
 */
export const rateLimitHitsTotal = new Counter({
  name: 'scoreboard_rate_limit_hits_total',
  help: 'Total rate limit checks by outcome (allowed|rejected|circuit_open)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Rate limit fail-CLOSED counter — incremented each time the guard throws 503
 * because Redis is unreachable (bucket.consume threw an error).
 * No labels — a rising count is the alert signal.
 */
export const rateLimitFailedClosedTotal = new Counter({
  name: 'scoreboard_rate_limit_failed_closed_total',
  help: 'Total times the rate-limit guard failed CLOSED (503) due to a Redis error',
  registers: [registry],
});

/**
 * Process start time gauge — set once at boot to record the Unix timestamp when the process started.
 * Useful for uptime and deploy-time dashboards.
 */
export const processStartTimeSeconds = new Gauge({
  name: 'scoreboard_process_start_time_seconds',
  help: 'Unix timestamp (seconds) at which the scoreboard process started',
  registers: [registry],
});
