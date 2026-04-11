// Mock kysely's sql tag — HealthService.pingPostgres uses sql`SELECT 1`.execute(db)
// We replace it with a function that returns an object with a controllable execute().
const sqlExecuteMock = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });

jest.mock('kysely', () => ({
  ...jest.requireActual('kysely'),
  sql: Object.assign(
    jest.fn(() => ({ execute: sqlExecuteMock })),
    // sql is also used as a namespace; spread real members so other imports work
    jest.requireActual('kysely').sql,
  ),
}));

import { HealthService } from '../../../../../src/scoreboard/interface/health/health.service';
import { ReadinessService } from '../../../../../src/shared/readiness/readiness.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeRedis(impl?: () => Promise<string>) {
  return { ping: jest.fn(impl ?? (() => Promise.resolve('PONG'))) };
}

function makeNatsWithJsm(streamInfoImpl?: () => Promise<unknown>) {
  const jsm = {
    streams: {
      info: jest.fn(streamInfoImpl ?? (() => Promise.resolve({ config: {} }))),
    },
  };
  return { jetstreamManager: jest.fn(() => Promise.resolve(jsm)) };
}

function makeReadiness(leaderboardReady = true) {
  const svc = new ReadinessService();
  svc.leaderboardReady = leaderboardReady;
  return svc;
}

// Minimal db stub — HealthService only calls sql`...`.execute(db) on it.
// The fake db is passed as the argument; the mock intercepts at the sql level.
const fakeDb = {} as never;

function buildService(opts: {
  redis?: ReturnType<typeof makeRedis>;
  nats?: ReturnType<typeof makeNatsWithJsm>;
  readiness?: ReadinessService;
  sqlImpl?: () => Promise<unknown>;
}): HealthService {
  if (opts.sqlImpl !== undefined) {
    sqlExecuteMock.mockImplementationOnce(opts.sqlImpl);
  }
  return new HealthService(
    fakeDb,
    (opts.redis ?? makeRedis()) as never,
    (opts.nats ?? makeNatsWithJsm()) as never,
    opts.readiness ?? makeReadiness(),
  );
}

// ---------------------------------------------------------------------------
// pingPostgres
// ---------------------------------------------------------------------------

describe('HealthService.pingPostgres', () => {
  beforeEach(() => {
    sqlExecuteMock.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  });

  it('returns { ok: true } when SELECT 1 succeeds', async () => {
    const svc = buildService({});
    const result = await svc.pingPostgres();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns { ok: false, reason } when db throws', async () => {
    const svc = buildService({
      sqlImpl: () => Promise.reject(new Error('connection refused')),
    });
    const result = await svc.pingPostgres();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('connection refused');
  });

  it('returns { ok: false, reason: "timeout" } when probe takes > 1000ms', async () => {
    jest.useFakeTimers();

    const svc = buildService({
      sqlImpl: () => new Promise(() => { /* never resolves */ }),
    });
    const resultPromise = svc.pingPostgres();

    jest.advanceTimersByTime(1100);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// pingRedis
// ---------------------------------------------------------------------------

describe('HealthService.pingRedis', () => {
  it('returns { ok: true } when redis.ping() succeeds', async () => {
    const svc = buildService({});
    const result = await svc.pingRedis();
    expect(result.ok).toBe(true);
  });

  it('returns { ok: false, reason } when redis.ping() throws', async () => {
    const redis = makeRedis(() => Promise.reject(new Error('ECONNREFUSED')));
    const svc = buildService({ redis });
    const result = await svc.pingRedis();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('returns { ok: false, reason: "timeout" } when probe takes > 1000ms', async () => {
    jest.useFakeTimers();

    const redis = makeRedis(() => new Promise(() => { /* never resolves */ }));
    const svc = buildService({ redis });
    const resultPromise = svc.pingRedis();

    jest.advanceTimersByTime(1100);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// pingNats
// ---------------------------------------------------------------------------

describe('HealthService.pingNats', () => {
  it('returns { ok: true } when jetstreamManager().streams.info() succeeds', async () => {
    const svc = buildService({});
    const result = await svc.pingNats();
    expect(result.ok).toBe(true);
  });

  it('returns { ok: false, reason } when streams.info() throws', async () => {
    const nats = makeNatsWithJsm(() => Promise.reject(new Error('stream not found')));
    const svc = buildService({ nats });
    const result = await svc.pingNats();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('stream not found');
  });

  it('returns { ok: false, reason } when jetstreamManager() throws', async () => {
    const nats = { jetstreamManager: jest.fn(() => Promise.reject(new Error('nats offline'))) };
    const svc = buildService({ nats });
    const result = await svc.pingNats();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nats offline');
  });

  it('returns { ok: false, reason: "timeout" } when probe takes > 1000ms', async () => {
    jest.useFakeTimers();

    const nats = makeNatsWithJsm(() => new Promise(() => { /* never resolves */ }));
    // Override jetstreamManager to also never resolve
    nats.jetstreamManager.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const svc = buildService({ nats });
    const resultPromise = svc.pingNats();

    jest.advanceTimersByTime(1100);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// leaderboardReady
// ---------------------------------------------------------------------------

describe('HealthService.leaderboardReady', () => {
  it('returns true when ReadinessService.leaderboardReady is true', () => {
    const svc = buildService({ readiness: makeReadiness(true) });
    expect(svc.leaderboardReady).toBe(true);
  });

  it('returns false when ReadinessService.leaderboardReady is false', () => {
    const svc = buildService({ readiness: makeReadiness(false) });
    expect(svc.leaderboardReady).toBe(false);
  });
});
