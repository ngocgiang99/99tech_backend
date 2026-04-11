import type { RequestHandler } from 'express';

import type { MetricsRegistry } from './metrics-registry.js';

/**
 * Safely extract the matched Express route pattern from a request-like
 * object, prefixed with any sub-router mount point.
 *
 * `req.route.path` is the pattern local to the matched sub-router — so a
 * request for `GET /resources/abc` that was matched inside the resources
 * sub-router returns `/:id`, not `/resources/:id`. Prefixing with
 * `req.baseUrl` yields the full pattern (`/resources/:id`), which matches
 * the cardinality spec and is much more useful for dashboards.
 *
 * Both fields are typed `any` / `string` in `@types/express` but can be
 * `undefined` at runtime — we handle that defensively and collapse any
 * ambiguity to the constant sentinel `__unmatched`.
 */
function extractRoutePath(req: { route?: unknown; baseUrl?: unknown }): string {
  const route = req.route;
  if (route === null || typeof route !== 'object') return '__unmatched';
  const path: unknown = (route as { path?: unknown }).path;
  if (typeof path !== 'string') return '__unmatched';

  const baseUrl: unknown = req.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return path;

  // When a sub-router mounts a `GET /` handler under `/resources`, the
  // naive concatenation yields `/resources/` (trailing slash). Strip the
  // trailing '/' in that one case so the label is `/resources`.
  if (path === '/') return baseUrl;
  return baseUrl + path;
}

/**
 * Express middleware that records one observation per request at
 * `res.on('finish')` time. Route is sourced from `req.route?.path` so it
 * stays a bounded set (e.g. `/resources/:id`) rather than the raw URL.
 * Unmatched routes collapse to the constant sentinel `__unmatched`.
 *
 * The middleware skips its own scrape endpoint so Prometheus scrapes do not
 * inflate the histogram with their own timings.
 */
export function createHttpMetricsMiddleware(registry: MetricsRegistry): RequestHandler {
  return (req, res, next) => {
    // Skip /metrics itself — scrape requests should not appear in the histogram.
    if (req.path === '/metrics') {
      next();
      return;
    }

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durationSeconds = Number(end - start) / 1_000_000_000;

      const route = extractRoutePath(req);
      const method = req.method;
      const statusCode = String(res.statusCode);

      registry.httpRequestDurationSeconds.observe(
        { method, route, status_code: statusCode },
        durationSeconds,
      );
      registry.httpRequestsTotal.inc({ method, route, status_code: statusCode });
    });

    next();
  };
}
