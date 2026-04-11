import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type Redis from 'ioredis';
import type pino from 'pino';

import type { Config, ParsedCidr } from '../config/env.js';
import { RateLimitError } from '../shared/errors.js';

/**
 * Dependency bag for the rate-limit middleware factory. Matches the shape
 * the other wired middlewares use (request-id, error-handler) so `buildApp`
 * can pass a single object rather than three positional arguments.
 */
export interface RateLimitDeps {
  readonly redis: Redis;
  readonly config: Config;
  readonly logger: pino.Logger;
}

// Convert the parsed CIDR list into a simple matcher used by the `skip`
// callback. The parsed form is a closure captured by the middleware so each
// call only walks the list once per request.
function buildAllowlistMatcher(
  allowlist: readonly ParsedCidr[],
): (ip: string) => boolean {
  // Pre-filter to the IPv4 entries — IPv6 matching is intentionally shallow
  // (the production assertion is the only concern that cares about IPv6 at
  // all, and the bench profile we actually use targets an IPv4 bridge).
  const ipv4Entries = allowlist.filter((e) => e.kind === 'ipv4' && e.ipv4);

  if (ipv4Entries.length === 0) {
    return () => false;
  }

  const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  function ipv4ToInt(match: RegExpMatchArray): number | null {
    const octets: number[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const n = Number(match[i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      octets.push(n);
    }
    return (
      ((octets[0]! << 24) |
        (octets[1]! << 16) |
        (octets[2]! << 8) |
        octets[3]!) >>>
      0
    );
  }

  return (ip: string): boolean => {
    // Normalise IPv4-mapped IPv6 (::ffff:192.168.1.5) to its v4 form.
    const candidate = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
    const m = IPV4_RE.exec(candidate);
    if (!m) return false;
    const intAddr = ipv4ToInt(m);
    if (intAddr === null) return false;
    for (const entry of ipv4Entries) {
      const cidr = entry.ipv4!;
      if (((intAddr & cidr.mask) >>> 0) === cidr.base) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Returns `true` for the three loopback forms the Node HTTP server can surface
 * (127.0.0.1, ::1, ::ffff:127.0.0.1) and `false` otherwise. A falsy `ip` is
 * NOT treated as loopback — otherwise a defensive shim could accidentally
 * open the bypass. See design.md Risks table.
 */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return false;
}

function isExcludedPath(path: string): boolean {
  // /healthz and any sub-path (e.g. /healthz?probe=liveness, /healthz/ready).
  // /metrics is exact-match only — prom-client exposes just the one route.
  if (path === '/healthz') return true;
  if (path.startsWith('/healthz/')) return true;
  if (path === '/metrics') return true;
  return false;
}

/**
 * The limiter's `handler` callback. Extracted from the factory closure so
 * unit tests can invoke it directly without spinning up a rate-limit-redis
 * store or a real express app. The closure shape is still exported via the
 * factory so production wiring is unchanged.
 */
function rateLimitExceededHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // express-rate-limit attaches a RateLimitInfo to req.rateLimit.
  // resetTime is a Date (ms precision). Compute the retryAfter in seconds,
  // clamped to >= 1 so clients never see Retry-After: 0.
  const info = (req as Request & {
    rateLimit?: { resetTime?: Date; limit?: number; remaining?: number };
  }).rateLimit;
  const resetMs = info?.resetTime ? info.resetTime.getTime() : Date.now() + 60_000;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));

  res.setHeader('Retry-After', String(retryAfterSeconds));

  next(
    new RateLimitError('Too many requests, please try again later.', {
      details: { retryAfterSeconds },
    }),
  );
}

/**
 * Factory for the per-IP rate-limit middleware. Wired into `buildApp` between
 * `pinoHttp` and `express.json()`. Returns a standard Express `RequestHandler`
 * so the caller can `app.use(createRateLimitMiddleware(deps))`.
 *
 * The factory is pure — it does not touch process state or open new
 * connections. The Redis client is reused from the response cache layer.
 */
export function createRateLimitMiddleware(deps: RateLimitDeps): RequestHandler {
  const { redis, config, logger } = deps;

  const isInAllowlist = buildAllowlistMatcher(config.rateLimitAllowlist);
  let warnedOnFalsyIp = false;

  // Build the Redis store. `rate-limit-redis` uses the injected client's
  // `call(...)` method (ioredis supports `.call()` for raw Redis commands),
  // so no extra connection is opened. The default prefix "rl:" keeps
  // rate-limit keys out of the response cache's key space.
  //
  // ioredis returns `unknown` from `.call()` — the rate-limit-redis typings
  // want `Promise<RedisReply>` where `RedisReply = string | number | boolean | Array<...>`.
  // The commands this store issues (INCR, EXPIRE, PEXPIRE, TTL, PTTL, EVALSHA)
  // always return one of those primitives, so the cast is safe; we go through
  // `unknown` to keep tsc honest about it.
  const store = new RedisStore({
    sendCommand: (async (...args: string[]) => {
      const result = await redis.call(args[0]!, ...args.slice(1));
      return result as string | number | boolean | Array<string | number | boolean>;
    }) as unknown as import('rate-limit-redis').SendCommandFn,
  });

  const skip = (req: Request): boolean => {
    const ip = req.ip;
    if (!ip) {
      // A falsy req.ip should never happen after trust proxy is set, but
      // if it does we count it (not skip) so the bucket still fires. Log
      // once per process so a tripwire is visible without flooding logs.
      if (!warnedOnFalsyIp) {
        warnedOnFalsyIp = true;
        logger.warn(
          { path: req.path },
          'rate-limit: req.ip is empty; falling through to counter (this should not happen after trust proxy is set)',
        );
      }
      return false;
    }
    if (isLoopback(ip)) return true;
    if (isInAllowlist(ip)) return true;
    if (isExcludedPath(req.path)) return true;
    return false;
  };

  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    skip,
    // Fourth `optionsUsed` arg of express-rate-limit's handler signature
    // is unused — our handler derives everything from req.rateLimit.
    handler: (req, res, next, _optionsUsed) =>
      rateLimitExceededHandler(req, res, next),
  });
}

/**
 * Test-only exports. Keeping these out of the public API prevents external
 * callers from depending on internal helpers while still allowing unit tests
 * in `tests/unit/middleware/rate-limit.test.ts` to exercise them directly.
 */
export const _test = {
  isLoopback,
  isExcludedPath,
  buildAllowlistMatcher,
  rateLimitExceededHandler,
};
