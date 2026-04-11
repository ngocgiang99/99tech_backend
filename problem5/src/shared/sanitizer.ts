/**
 * Sensitive-header scrubber.
 *
 * Replaces values of denylisted header names with "[REDACTED]" before logging.
 * The scrubber does NOT read process.env — callers supply the extra denylist
 * as a parameter so the function is pure and independently testable.
 *
 * Array-valued headers (e.g. multi-value Set-Cookie) are replaced with a
 * single "[REDACTED]" string rather than an array of equal length, because
 * the number of Set-Cookie values is itself potentially fingerprinting data.
 */

const DEFAULT_DENYLIST: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
];

/**
 * Scrub sensitive headers from `headers`.
 *
 * @param headers          The headers object to scrub (not mutated).
 * @param extraDenylist    Additional header names (case-insensitive) to redact.
 * @returns A new object with the same keys; denylisted values replaced with "[REDACTED]".
 */
export function scrubHeaders(
  headers: Record<string, unknown>,
  extraDenylist: readonly string[] = [],
): Record<string, unknown> {
  const denySet = new Set([
    ...DEFAULT_DENYLIST,
    ...extraDenylist.map((h) => h.toLowerCase()),
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (denySet.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}
