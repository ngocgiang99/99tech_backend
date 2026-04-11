import 'dotenv/config';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CACHE_DETAIL_TTL_SECONDS: z.coerce.number().int().min(1).default(300),
  CACHE_LIST_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  CACHE_LIST_VERSION_KEY_PREFIX: z.string().min(1).default('resource:list:version'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10000),
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  METRICS_DEFAULT_METRICS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Comma-separated list of additional header names to redact from error logs.
  // Example: LOG_SCRUBBER_EXTRA_HEADERS=x-internal-secret,x-jwt
  LOG_SCRUBBER_EXTRA_HEADERS: z.string().default(''),
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1).default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(1000),
  RATE_LIMIT_ALLOWLIST_CIDRS: z.string().default(''),
});

export type RawConfig = z.infer<typeof envSchema>;

export interface Config extends RawConfig {
  /**
   * Parsed CIDR entries from `RATE_LIMIT_ALLOWLIST_CIDRS`. Each entry is the
   * caller-normalised CIDR string (lowercased, trimmed). The `kind` tells the
   * middleware which matcher to use. Loopback is NOT represented here — it is
   * always-bypass regardless of this list.
   */
  readonly rateLimitAllowlist: ReadonlyArray<ParsedCidr>;
}

export interface ParsedCidr {
  readonly raw: string;
  readonly kind: 'ipv4' | 'ipv6';
  /** Numeric base for IPv4 CIDRs, left undefined for IPv6 (unused at runtime). */
  readonly ipv4?: {
    /** Big-endian 32-bit integer representation of the base address. */
    readonly base: number;
    /** Prefix length 0..32. */
    readonly prefix: number;
    /** Precomputed network mask (or 0 for /0). */
    readonly mask: number;
  };
}

/** Thrown (or signalled via process.exit) when CIDR parsing or safety checks fail. */
interface CidrParseError {
  readonly entry: string;
  readonly reason: string;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4Octets(addr: string): [number, number, number, number] | null {
  const m = IPV4_RE.exec(addr);
  if (!m) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function ipv4ToInt(octets: readonly [number, number, number, number]): number {
  // Use unsigned shift to keep the result in the 0..2^32-1 range.
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

function maskForPrefix(prefix: number): number {
  // prefix=0 → 0, prefix=32 → 0xFFFFFFFF. JS bitshift of 32 is undefined
  // (wraps to 0), so handle the edges explicitly.
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (~0 << (32 - prefix)) >>> 0;
}

/**
 * Parse one CIDR string into a `ParsedCidr` or return a `CidrParseError`.
 * Accepts both bare addresses (treated as /32 for IPv4, /128 for IPv6) and
 * `address/prefix` forms. IPv6 support is intentionally shallow: we recognize
 * well-formed entries enough to detect `::/0` for the safety assertion, but
 * do not implement full IPv6 bitmask matching — see design.md Decision 4.
 */
function parseSingleCidr(raw: string): ParsedCidr | CidrParseError {
  const entry = raw.trim();
  if (!entry) return { entry, reason: 'empty entry' };

  // Split on '/'. Missing slash means an implicit full-host prefix.
  const slashIdx = entry.indexOf('/');
  const addrPart = slashIdx === -1 ? entry : entry.slice(0, slashIdx);
  const prefixPart = slashIdx === -1 ? null : entry.slice(slashIdx + 1);

  // Try IPv4 first
  const v4Octets = parseIpv4Octets(addrPart);
  if (v4Octets) {
    let prefix = 32;
    if (prefixPart !== null) {
      const n = Number(prefixPart);
      if (!Number.isInteger(n) || n < 0 || n > 32) {
        return { entry, reason: `invalid IPv4 prefix "${prefixPart}"` };
      }
      prefix = n;
    }
    const base = ipv4ToInt(v4Octets) >>> 0;
    const mask = maskForPrefix(prefix);
    return {
      raw: entry,
      kind: 'ipv4',
      ipv4: { base: (base & mask) >>> 0, prefix, mask },
    };
  }

  // IPv6 — shallow parse. Accept anything that contains at least one ':'
  // and only hex/digits/colons/dots (for v4-mapped forms). Prefix 0..128.
  if (addrPart.includes(':')) {
    if (!/^[0-9a-fA-F:.]+$/.test(addrPart)) {
      return { entry, reason: `invalid IPv6 characters in "${addrPart}"` };
    }
    let prefix = 128;
    if (prefixPart !== null) {
      const n = Number(prefixPart);
      if (!Number.isInteger(n) || n < 0 || n > 128) {
        return { entry, reason: `invalid IPv6 prefix "${prefixPart}"` };
      }
      prefix = n;
    }
    // Defensive: reject empty or all-colon garbage. A legitimate IPv6 has
    // at most eight 16-bit groups, but validating that properly is more
    // code than the safety assertion needs. The middleware will not match
    // any real request against this entry, so a typo here only affects
    // the allow-list and is surfaced via unit tests for parseCidrList.
    if (addrPart.replace(/[^:]/g, '').length > 8) {
      return { entry, reason: `too many colons in "${addrPart}"` };
    }
    return {
      raw: `${addrPart}/${prefix}`,
      kind: 'ipv6',
    };
  }

  return { entry, reason: `not a valid IPv4 or IPv6 address: "${addrPart}"` };
}

/**
 * Split a comma-separated CIDR list into parsed entries.
 * Whitespace around commas and trailing commas are tolerated; empty entries
 * (e.g. from a blank env var) are dropped.
 *
 * On any parse failure, returns the accumulated errors so the caller can
 * format a single aggregate message before `process.exit(1)`.
 */
export function parseCidrList(raw: string): {
  parsed: ParsedCidr[];
  errors: CidrParseError[];
} {
  const parsed: ParsedCidr[] = [];
  const errors: CidrParseError[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const result = parseSingleCidr(trimmed);
    if ('reason' in result) {
      errors.push(result);
    } else {
      parsed.push(result);
    }
  }
  return { parsed, errors };
}

/**
 * Return every CIDR in the list that is "wide open" — matches the whole
 * IPv4 or IPv6 address space. The production safety assertion refuses to
 * boot if any such entry is present.
 *
 * Wide-open means:
 *   - IPv4 with prefix 0 (e.g. 0.0.0.0/0, 0.0.0.0/1 counted by prefix ≤ 1
 *     because a /1 also includes 0.0.0.0 and half the public internet)
 *   - IPv6 equal to ::/0
 */
export function findWideOpenCidrs(parsed: readonly ParsedCidr[]): string[] {
  const hits: string[] = [];
  for (const entry of parsed) {
    if (entry.kind === 'ipv4') {
      // Treat /0 and /1 as wide-open: a /1 covers half of IPv4 including
      // the entire public internet routable range, which is close enough
      // to 0.0.0.0/0 to warrant the same refusal in production.
      if (entry.ipv4!.prefix <= 1) {
        hits.push(entry.raw);
      }
    } else {
      // IPv6 — we only catch the obvious ::/0 literal and its equivalents.
      // Anything tighter than that is accepted.
      const norm = entry.raw.replace(/\s+/g, '').toLowerCase();
      if (norm === '::/0' || norm === '::/1') {
        hits.push(entry.raw);
      }
    }
  }
  return hits;
}

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    process.stderr.write(
      `[config] Failed to load environment configuration:\n${formatted}\n`,
    );
    process.exit(1);
  }

  const raw = result.data;

  // Parse the CIDR allow-list. Invalid entries fail startup in every env
  // so a typo never silently turns the bypass off.
  const { parsed: rateLimitAllowlist, errors: cidrErrors } = parseCidrList(
    raw.RATE_LIMIT_ALLOWLIST_CIDRS,
  );
  if (cidrErrors.length > 0) {
    const formatted = cidrErrors
      .map((e) => `  - "${e.entry}": ${e.reason}`)
      .join('\n');
    process.stderr.write(
      `[config] RATE_LIMIT_ALLOWLIST_CIDRS contains invalid entries:\n${formatted}\n`,
    );
    process.exit(1);
  }

  // Production safety assertion: a wide-open CIDR in prod would silently
  // turn the limiter into a no-op. Refuse to start.
  const wideOpen = findWideOpenCidrs(rateLimitAllowlist);
  if (wideOpen.length > 0) {
    if (raw.NODE_ENV === 'production') {
      process.stderr.write(
        `[config] RATE_LIMIT_ALLOWLIST_CIDRS contains wide-open CIDR(s) ` +
          `(${wideOpen.join(', ')}). Refusing to start in production. ` +
          `See openspec/changes/s12-add-rate-limit-middleware/design.md ` +
          `(Decision 4) for why this is blocked.\n`,
      );
      process.exit(1);
    } else {
      process.stderr.write(
        `[config] WARN: RATE_LIMIT_ALLOWLIST_CIDRS contains wide-open CIDR(s) ` +
          `(${wideOpen.join(', ')}). This is tolerated in ${raw.NODE_ENV} but would ` +
          `refuse to start in production.\n`,
      );
    }
  }

  return {
    ...raw,
    rateLimitAllowlist,
  };
}
