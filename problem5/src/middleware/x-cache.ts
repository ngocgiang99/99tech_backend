import type { RequestHandler } from 'express';

import type { CacheStatus } from '../modules/resources/request-context.js';

/**
 * Reads `res.locals.cacheStatus` (set by the resources controller after
 * GET handlers) and mirrors it into the `X-Cache` response header before
 * the body goes out. Keeps the repository HTTP-agnostic.
 *
 * The header is suppressed in production to avoid disclosing cache state
 * to clients (mild fingerprinting / cache-poisoning recon signal). It
 * stays on in development and test so k6 benchmarks in S05 can assert
 * hit rates.
 */
export function xCacheMiddleware(nodeEnv: string): RequestHandler {
  const emit = nodeEnv !== 'production';
  return (_req, res, next) => {
    if (!emit) {
      next();
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.locals['cacheStatus'] as CacheStatus | undefined;
      if (status && !res.headersSent) {
        res.setHeader('X-Cache', status);
      }
      return originalJson(body);
    };
    next();
  };
}
