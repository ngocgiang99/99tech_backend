import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findWideOpenCidrs,
  loadConfig,
  parseCidrList,
} from '../../../src/config/env.js';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
};

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function clearRateLimitEnv(): void {
  setEnv({
    NODE_ENV: undefined,
    RATE_LIMIT_ENABLED: undefined,
    RATE_LIMIT_WINDOW_MS: undefined,
    RATE_LIMIT_MAX: undefined,
    RATE_LIMIT_ALLOWLIST_CIDRS: undefined,
  });
}

// --- parseCidrList ----------------------------------------------------------

describe('parseCidrList', () => {
  it('handles empty string', () => {
    const { parsed, errors } = parseCidrList('');
    expect(parsed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('handles whitespace-only string', () => {
    const { parsed, errors } = parseCidrList('   ');
    expect(parsed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('parses a single IPv4 CIDR', () => {
    const { parsed, errors } = parseCidrList('192.168.1.0/24');
    expect(errors).toEqual([]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.kind).toBe('ipv4');
    expect(parsed[0]?.ipv4?.prefix).toBe(24);
  });

  it('parses comma-separated IPv4 CIDRs with whitespace', () => {
    const { parsed, errors } = parseCidrList(' 10.0.0.0/8 , 172.16.0.0/12 ,');
    expect(errors).toEqual([]);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.raw)).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('parses mixed IPv4 and IPv6 entries', () => {
    const { parsed, errors } = parseCidrList('10.0.0.0/8,::1/128');
    expect(errors).toEqual([]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.kind).toBe('ipv4');
    expect(parsed[1]?.kind).toBe('ipv6');
  });

  it('rejects garbage', () => {
    const { parsed, errors } = parseCidrList('not-a-cidr');
    expect(parsed).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.entry).toBe('not-a-cidr');
  });

  it('rejects invalid IPv4 prefix', () => {
    const { parsed, errors } = parseCidrList('192.168.1.0/64');
    expect(parsed).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('rejects out-of-range octet', () => {
    const { parsed, errors } = parseCidrList('256.1.1.1/24');
    expect(parsed).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('accepts bare IPv4 address as /32', () => {
    const { parsed, errors } = parseCidrList('192.168.1.5');
    expect(errors).toEqual([]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.ipv4?.prefix).toBe(32);
  });
});

// --- findWideOpenCidrs ------------------------------------------------------

describe('findWideOpenCidrs', () => {
  it('flags 0.0.0.0/0', () => {
    const { parsed } = parseCidrList('0.0.0.0/0');
    expect(findWideOpenCidrs(parsed)).toEqual(['0.0.0.0/0']);
  });

  it('flags 0.0.0.0/1 (half the internet)', () => {
    const { parsed } = parseCidrList('0.0.0.0/1');
    expect(findWideOpenCidrs(parsed)).toEqual(['0.0.0.0/1']);
  });

  it('does NOT flag 10.0.0.0/8', () => {
    const { parsed } = parseCidrList('10.0.0.0/8');
    expect(findWideOpenCidrs(parsed)).toEqual([]);
  });

  it('flags ::/0', () => {
    const { parsed } = parseCidrList('::/0');
    expect(findWideOpenCidrs(parsed)).toEqual(['::/0']);
  });

  it('does NOT flag ::1/128', () => {
    const { parsed } = parseCidrList('::1/128');
    expect(findWideOpenCidrs(parsed)).toEqual([]);
  });

  it('flags wide-open entries among a mixed list', () => {
    const { parsed } = parseCidrList('10.0.0.0/8,0.0.0.0/0,::1/128');
    expect(findWideOpenCidrs(parsed)).toEqual(['0.0.0.0/0']);
  });
});

// --- loadConfig — production safety assertion --------------------------------

describe('loadConfig — rate limit allow-list', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Make process.exit throw so tests can observe it without actually dying.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Reset env to a known base per test.
    process.env = { ...originalEnv };
    setEnv({ ...BASE_ENV, RATE_LIMIT_ENABLED: 'true' });
    clearRateLimitEnv();
    setEnv({ ...BASE_ENV });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it('parses a valid allow-list into ParsedCidr entries', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_ALLOWLIST_CIDRS: '10.0.0.0/8,172.16.0.0/12' });
    const cfg = loadConfig();
    expect(cfg.rateLimitAllowlist).toHaveLength(2);
    expect(cfg.rateLimitAllowlist.map((c) => c.raw)).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
    ]);
  });

  it('exits when NODE_ENV=production and allow-list contains 0.0.0.0/0', () => {
    setEnv({ NODE_ENV: 'production', RATE_LIMIT_ALLOWLIST_CIDRS: '0.0.0.0/0' });
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Refusing to start in production');
    expect(written).toContain('0.0.0.0/0');
  });

  it('exits when NODE_ENV=production and allow-list contains ::/0', () => {
    setEnv({ NODE_ENV: 'production', RATE_LIMIT_ALLOWLIST_CIDRS: '::/0' });
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Refusing to start in production');
    expect(written).toContain('::/0');
  });

  it('warns but continues in development when allow-list contains 0.0.0.0/0', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_ALLOWLIST_CIDRS: '0.0.0.0/0' });
    const cfg = loadConfig();
    expect(cfg.rateLimitAllowlist).toHaveLength(1);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('WARN');
    expect(written).toContain('0.0.0.0/0');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits when allow-list contains invalid CIDR syntax in any env', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_ALLOWLIST_CIDRS: 'not-a-cidr' });
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('invalid entries');
    expect(written).toContain('not-a-cidr');
  });

  it('exits when RATE_LIMIT_MAX is negative', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_MAX: '-5' });
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
  });

  it('defaults are applied when rate-limit env vars are unset', () => {
    setEnv({ NODE_ENV: 'development' });
    const cfg = loadConfig();
    expect(cfg.RATE_LIMIT_ENABLED).toBe(true);
    expect(cfg.RATE_LIMIT_WINDOW_MS).toBe(60000);
    expect(cfg.RATE_LIMIT_MAX).toBe(1000);
    expect(cfg.rateLimitAllowlist).toEqual([]);
  });

  it('RATE_LIMIT_ENABLED=false coerces to boolean false', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: 'false' });
    const cfg = loadConfig();
    expect(cfg.RATE_LIMIT_ENABLED).toBe(false);
  });
});
