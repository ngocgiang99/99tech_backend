import {
  resolveRequestId,
  buildPinoLoggerOptions,
} from '../../../src/shared/logger/pino-logger.factory';

// Helper: cast the union return type of buildPinoLoggerOptions to a plain record
// so individual option fields are accessible in tests without pulling in pino-http types.
function asOptions(raw: ReturnType<typeof buildPinoLoggerOptions>): Record<string, unknown> {
  return raw as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// resolveRequestId tests
// ---------------------------------------------------------------------------

describe('resolveRequestId', () => {
  it('returns a valid inbound header value unchanged', () => {
    const result = resolveRequestId('ABCDEFGHIJKLMNOP'); // 16 chars, alphanumeric
    expect(result).toBe('ABCDEFGHIJKLMNOP');
  });

  it('accepts a 40-character alphanumeric header', () => {
    const id = 'A'.repeat(40);
    expect(resolveRequestId(id)).toBe(id);
  });

  it('takes the first element when the header is an array', () => {
    const result = resolveRequestId(['ABCDEFGHIJKLMNOP', 'other']);
    expect(result).toBe('ABCDEFGHIJKLMNOP');
  });

  it('generates a ULID when the header is undefined', () => {
    const result = resolveRequestId(undefined);
    // ULID is 26 characters uppercase alphanumeric
    expect(typeof result).toBe('string');
    expect(result.length).toBe(26);
  });

  it('generates a ULID when the header is an empty string', () => {
    const result = resolveRequestId('');
    expect(result.length).toBe(26);
  });

  it('generates a ULID when the header is too short (< 16 chars)', () => {
    const result = resolveRequestId('abc');
    expect(result.length).toBe(26);
  });

  it('generates a ULID when the header is too long (> 40 chars)', () => {
    const result = resolveRequestId('A'.repeat(41));
    expect(result.length).toBe(26);
  });

  it('generates a ULID when the header contains invalid characters', () => {
    const result = resolveRequestId('abc-def-123!@#$%^&*');
    expect(result.length).toBe(26);
  });

  it('generates a ULID when the array first element is invalid', () => {
    const result = resolveRequestId(['short', 'ABCDEFGHIJKLMNOP']);
    expect(result.length).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// buildPinoLoggerOptions tests
// ---------------------------------------------------------------------------

describe('buildPinoLoggerOptions', () => {
  function makeConfig(overrides: Record<string, unknown> = {}) {
    const defaults: Record<string, unknown> = {
      LOG_LEVEL: 'info',
      NODE_ENV: 'production',
    };
    return {
      get: jest.fn((key: string) => overrides[key] ?? defaults[key]),
    };
  }

  it('returns options object with the configured log level', () => {
    const config = makeConfig({ LOG_LEVEL: 'debug' });
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    expect(opts.level).toBe('debug');
  });

  it('does NOT include transport in production', () => {
    const config = makeConfig({ NODE_ENV: 'production' });
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    expect(opts.transport).toBeUndefined();
  });

  it('includes pino-pretty transport in development', () => {
    const config = makeConfig({ NODE_ENV: 'development' });
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    expect(opts.transport).toBeDefined();
    expect((opts.transport as Record<string, unknown>).target).toBe('pino-pretty');
  });

  it('includes redact paths for sensitive headers', () => {
    const config = makeConfig();
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    const redact = opts.redact as { paths: string[]; remove: boolean };
    expect(redact.paths).toContain('req.headers.authorization');
    expect(redact.paths).toContain('req.headers["action-token"]');
    expect(redact.remove).toBe(true);
  });

  it('genReqId returns a valid request ID from x-request-id header', () => {
    const config = makeConfig();
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    const genReqId = opts.genReqId as (req: unknown, reply: unknown) => string;

    const req = { headers: { 'x-request-id': 'ABCDEFGHIJKLMNOP' } };
    const reply = { header: jest.fn() };
    const id = genReqId(req, reply);

    expect(id).toBe('ABCDEFGHIJKLMNOP');
    expect(reply.header).toHaveBeenCalledWith('X-Request-Id', 'ABCDEFGHIJKLMNOP');
  });

  it('genReqId generates a ULID when no x-request-id header is present', () => {
    const config = makeConfig();
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    const genReqId = opts.genReqId as (req: unknown, reply: unknown) => string;

    const req = { headers: {} };
    const reply = { header: jest.fn() };
    const id = genReqId(req, reply);

    expect(id.length).toBe(26); // ULID length
  });

  it('genReqId falls back to setHeader when reply.header is not a function', () => {
    const config = makeConfig();
    const opts = asOptions(buildPinoLoggerOptions(config as never));
    const genReqId = opts.genReqId as (req: unknown, reply: unknown) => string;

    const req = { headers: { 'x-request-id': 'ABCDEFGHIJKLMNOP' } };
    const reply = { setHeader: jest.fn() };
    genReqId(req, reply);

    expect(reply.setHeader).toHaveBeenCalledWith('X-Request-Id', 'ABCDEFGHIJKLMNOP');
  });
});
