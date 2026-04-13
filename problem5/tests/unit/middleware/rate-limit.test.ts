import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { parseCidrList } from '../../../src/config/env.js';
import { _test } from '../../../src/middleware/rate-limit.js';
import { RateLimitError } from '../../../src/shared/errors.js';

const { isLoopback, isExcludedPath, buildAllowlistMatcher, rateLimitExceededHandler } = _test;

// --- isLoopback -------------------------------------------------------------

describe('isLoopback', () => {
  it('returns true for 127.0.0.1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });

  it('returns true for ::1', () => {
    expect(isLoopback('::1')).toBe(true);
  });

  it('returns true for ::ffff:127.0.0.1', () => {
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('returns false for an IPv4-mapped NON-loopback (::ffff:192.168.1.1)', () => {
    expect(isLoopback('::ffff:192.168.1.1')).toBe(false);
  });

  it('returns false for a private IPv4 (192.168.1.1)', () => {
    expect(isLoopback('192.168.1.1')).toBe(false);
  });

  it('returns false for a public IPv4 (203.0.113.5)', () => {
    expect(isLoopback('203.0.113.5')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isLoopback('')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isLoopback(undefined)).toBe(false);
  });
});

// --- isExcludedPath ---------------------------------------------------------

describe('isExcludedPath', () => {
  it('excludes /healthz exactly', () => {
    expect(isExcludedPath('/healthz')).toBe(true);
  });

  it('excludes /healthz sub-paths', () => {
    expect(isExcludedPath('/healthz/ready')).toBe(true);
    expect(isExcludedPath('/healthz/live')).toBe(true);
  });

  it('excludes /metrics exactly', () => {
    expect(isExcludedPath('/metrics')).toBe(true);
  });

  it('does NOT exclude /metricsx (false sub-match)', () => {
    expect(isExcludedPath('/metricsx')).toBe(false);
  });

  it('does NOT exclude /resources', () => {
    expect(isExcludedPath('/api/v1/resources')).toBe(false);
  });

  it('does NOT exclude the root', () => {
    expect(isExcludedPath('/')).toBe(false);
  });
});

// --- buildAllowlistMatcher --------------------------------------------------

describe('buildAllowlistMatcher', () => {
  it('returns false for empty list', () => {
    const matcher = buildAllowlistMatcher([]);
    expect(matcher('192.168.1.5')).toBe(false);
    expect(matcher('10.0.0.1')).toBe(false);
  });

  it('matches a /24 CIDR', () => {
    const { parsed } = parseCidrList('192.168.1.0/24');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('192.168.1.5')).toBe(true);
    expect(matcher('192.168.1.255')).toBe(true);
    expect(matcher('192.168.2.5')).toBe(false);
  });

  it('matches a /8 CIDR', () => {
    const { parsed } = parseCidrList('10.0.0.0/8');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('10.0.0.1')).toBe(true);
    expect(matcher('10.255.255.255')).toBe(true);
    expect(matcher('11.0.0.1')).toBe(false);
  });

  it('matches across multiple CIDRs', () => {
    const { parsed } = parseCidrList('10.0.0.0/8,192.168.0.0/16');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('10.1.2.3')).toBe(true);
    expect(matcher('192.168.50.5')).toBe(true);
    expect(matcher('172.16.0.1')).toBe(false);
  });

  it('matches /32 single-host entries', () => {
    const { parsed } = parseCidrList('172.16.5.10/32');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('172.16.5.10')).toBe(true);
    expect(matcher('172.16.5.11')).toBe(false);
  });

  it('matches /0 (wide open) — used only in unit tests', () => {
    // We never ship with /0 in production (config assertion blocks it) but
    // the matcher itself must accept it so the allow-list semantics are
    // regular.
    const { parsed } = parseCidrList('0.0.0.0/0');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('1.2.3.4')).toBe(true);
    expect(matcher('255.255.255.255')).toBe(true);
  });

  it('normalises IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)', () => {
    const { parsed } = parseCidrList('192.168.1.0/24');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('::ffff:192.168.1.5')).toBe(true);
    expect(matcher('::ffff:192.168.2.5')).toBe(false);
  });

  it('returns false for any IPv6 when the allow-list only has IPv4 entries', () => {
    const { parsed } = parseCidrList('10.0.0.0/8');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('2001:db8::1')).toBe(false);
  });

  it('returns false for garbage input', () => {
    const { parsed } = parseCidrList('10.0.0.0/8');
    const matcher = buildAllowlistMatcher(parsed);
    expect(matcher('not-an-ip')).toBe(false);
    expect(matcher('')).toBe(false);
  });
});

// --- rateLimitExceededHandler (the 429 producer) ---------------------------

function buildReq(
  overrides: Partial<Request> & { rateLimit?: { resetTime?: Date } } = {},
): Request {
  return {
    rateLimit: overrides.rateLimit,
    ...overrides,
  } as unknown as Request;
}

function buildRes(): Response {
  return {
    setHeader: vi.fn(),
  } as unknown as Response;
}

describe('rateLimitExceededHandler', () => {
  it('calls next exactly once with a RateLimitError', () => {
    const req = buildReq({ rateLimit: { resetTime: new Date(Date.now() + 30_000) } });
    const res = buildRes();
    const next: NextFunction = vi.fn();

    rateLimitExceededHandler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).code).toBe('RATE_LIMIT');
    expect((err as RateLimitError).status).toBe(429);
  });

  it('sets Retry-After header with a positive integer value', () => {
    const req = buildReq({ rateLimit: { resetTime: new Date(Date.now() + 42_000) } });
    const res = buildRes();
    const next: NextFunction = vi.fn();

    rateLimitExceededHandler(req, res, next);

    const setHeaderCalls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    const headerCall = setHeaderCalls.find((c) => c[0] === 'Retry-After');
    expect(headerCall).toBeDefined();
    const value = Number(headerCall![1]);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it('clamps Retry-After to minimum 1 even when resetTime is in the past', () => {
    const req = buildReq({ rateLimit: { resetTime: new Date(Date.now() - 5_000) } });
    const res = buildRes();
    const next: NextFunction = vi.fn();

    rateLimitExceededHandler(req, res, next);

    const setHeaderCalls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    const headerCall = setHeaderCalls.find((c) => c[0] === 'Retry-After');
    expect(Number(headerCall![1])).toBe(1);
  });

  it('falls back to a default when req.rateLimit is undefined', () => {
    const req = buildReq({});
    const res = buildRes();
    const next: NextFunction = vi.fn();

    rateLimitExceededHandler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(RateLimitError);
    const setHeaderCalls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    const headerCall = setHeaderCalls.find((c) => c[0] === 'Retry-After');
    expect(Number(headerCall![1])).toBeGreaterThanOrEqual(1);
  });

  it('attaches retryAfterSeconds to the RateLimitError details', () => {
    const req = buildReq({ rateLimit: { resetTime: new Date(Date.now() + 15_000) } });
    const res = buildRes();
    const next: NextFunction = vi.fn();

    rateLimitExceededHandler(req, res, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as RateLimitError;
    const details = err.details as { retryAfterSeconds?: number };
    expect(details?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

// --- skip composition (mirrors the skip closure built by the factory) ------

describe('skip composition', () => {
  const { parsed } = parseCidrList('10.0.0.0/8');
  const isInAllowlist = buildAllowlistMatcher(parsed);

  // Reconstruct the skip predicate the factory builds. The real factory also
  // accepts a falsy req.ip and logs once — that branch is covered by the
  // isLoopback('') test above, so this helper focuses on the positive cases.
  function skipPredicate(ip: string, path: string): boolean {
    if (isLoopback(ip)) return true;
    if (isInAllowlist(ip)) return true;
    if (isExcludedPath(path)) return true;
    return false;
  }

  it('returns true for a loopback IP regardless of path', () => {
    expect(skipPredicate('127.0.0.1', '/api/v1/resources')).toBe(true);
    expect(skipPredicate('127.0.0.1', '/api/v1/resources/abc')).toBe(true);
    expect(skipPredicate('::1', '/api/v1/resources')).toBe(true);
  });

  it('returns true for /healthz regardless of IP', () => {
    expect(skipPredicate('203.0.113.5', '/healthz')).toBe(true);
    expect(skipPredicate('203.0.113.5', '/healthz/ready')).toBe(true);
  });

  it('returns true for /metrics regardless of IP', () => {
    expect(skipPredicate('203.0.113.5', '/metrics')).toBe(true);
  });

  it('returns false for a non-loopback IP on a non-excluded path', () => {
    expect(skipPredicate('203.0.113.5', '/api/v1/resources')).toBe(false);
  });

  it('returns true for an allow-listed non-loopback IP on a non-excluded path', () => {
    expect(skipPredicate('10.5.5.5', '/api/v1/resources')).toBe(true);
  });

  it('returns false for a non-allow-listed IP on /resources', () => {
    expect(skipPredicate('192.168.1.5', '/api/v1/resources')).toBe(false);
  });
});
