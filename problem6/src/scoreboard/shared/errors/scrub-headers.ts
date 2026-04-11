/**
 * Default list of header names whose values MUST be redacted before logging.
 * Matching is case-insensitive.
 */
export const DEFAULT_HEADER_DENYLIST: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'action-token',
];

const REDACTED = '[redacted]';

/**
 * Return a NEW object with denylisted header values replaced by "[redacted]".
 * Non-denylisted entries pass through unchanged. Matching is case-insensitive.
 */
export function scrubHeaders(
  headers: Record<string, unknown>,
  extraDenylist?: readonly string[],
): Record<string, unknown> {
  const denySet = new Set<string>(
    [...DEFAULT_HEADER_DENYLIST, ...(extraDenylist ?? [])].map((h) =>
      h.toLowerCase(),
    ),
  );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = denySet.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}
