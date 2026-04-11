import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createHttpMetricsMiddleware } from '../../../src/observability/http-metrics.js';
import { MetricsRegistry } from '../../../src/observability/metrics-registry.js';

/**
 * Minimal req/res stubs sufficient for the middleware. The middleware only
 * reads `req.path`, `req.method`, `req.route`, `res.statusCode`, and wires
 * a listener via `res.on('finish', ...)` — so an EventEmitter-based stub
 * with a few fields is enough.
 */
function buildReqRes(opts: {
  path: string;
  method: string;
  route?: { path: string };
  statusCode: number;
}): {
  req: {
    path: string;
    method: string;
    route?: { path: string };
  };
  res: EventEmitter & { statusCode: number };
  finish: () => void;
} {
  const req = {
    path: opts.path,
    method: opts.method,
    ...(opts.route ? { route: opts.route } : {}),
  };
  const res = Object.assign(new EventEmitter(), { statusCode: opts.statusCode });
  return { req, res, finish: () => res.emit('finish') };
}

async function renderMetric(registry: MetricsRegistry): Promise<string> {
  return registry.render();
}

describe('createHttpMetricsMiddleware', () => {
  it('records the matched route pattern, not the raw URL', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    const { req, res, finish } = buildReqRes({
      path: '/resources/abc-123-def',
      method: 'GET',
      route: { path: '/resources/:id' },
      statusCode: 200,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => undefined);
    finish();

    const output = await renderMetric(registry);
    expect(output).toContain('route="/resources/:id"');
    expect(output).not.toContain('route="/resources/abc-123-def"');
  });

  it('strips trailing slash when sub-router root is the matched route', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    // Simulate GET /resources handled by `router.get('/')` mounted at '/resources'.
    const req = {
      path: '/resources',
      method: 'GET',
      baseUrl: '/resources',
      route: { path: '/' },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => undefined);
    res.emit('finish');

    const output = await renderMetric(registry);
    expect(output).toContain('route="/resources"');
    expect(output).not.toContain('route="/resources/"');
  });

  it('prefixes sub-router mount point (baseUrl) onto the route pattern', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    // Simulate the resources sub-router: the handler saw path '/:id' with
    // baseUrl '/resources', and the full pattern should be '/resources/:id'.
    const req = {
      path: '/resources/abc',
      method: 'GET',
      baseUrl: '/resources',
      route: { path: '/:id' },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => undefined);
    res.emit('finish');

    const output = await renderMetric(registry);
    expect(output).toContain('route="/resources/:id"');
    expect(output).not.toContain('route="/:id"');
  });

  it('falls back to __unmatched when req.route is absent', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    const { req, res, finish } = buildReqRes({
      path: '/nowhere-such',
      method: 'GET',
      statusCode: 404,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => undefined);
    finish();

    const output = await renderMetric(registry);
    expect(output).toContain('route="__unmatched"');
  });

  it('records status_code as a string label (not a number)', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    const { req, res, finish } = buildReqRes({
      path: '/x',
      method: 'POST',
      route: { path: '/x' },
      statusCode: 500,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => undefined);
    finish();

    const output = await renderMetric(registry);
    expect(output).toContain('status_code="500"');
  });

  it('skips /metrics scrape requests', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    const { req, res, finish } = buildReqRes({
      path: '/metrics',
      method: 'GET',
      route: { path: '/metrics' },
      statusCode: 200,
    });

    let nextCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    finish();

    expect(nextCalled).toBe(true);
    const output = await renderMetric(registry);
    expect(output).not.toContain('route="/metrics"');
  });

  it('increments counter once per request', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    const middleware = createHttpMetricsMiddleware(registry);

    for (let i = 0; i < 3; i++) {
      const { req, res, finish } = buildReqRes({
        path: '/resources',
        method: 'GET',
        route: { path: '/resources' },
        statusCode: 200,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      middleware(req as any, res as any, () => undefined);
      finish();
    }

    const output = await renderMetric(registry);
    // The counter should be 3. The exposition-format value is the last
    // field of the sample line.
    const match = output.match(
      /^http_requests_total\{[^}]*route="\/resources"[^}]*\} (\d+)/m,
    );
    expect(match?.[1]).toBe('3');
  });
});
