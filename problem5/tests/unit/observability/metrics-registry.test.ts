import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../../../src/observability/metrics-registry.js';

describe('MetricsRegistry', () => {
  it('constructs every custom metric with the expected name', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    // Record one sample per metric so the exposition-format output contains
    // them. Counter/Gauge/Histogram all have inc/set/observe with default
    // label values.
    registry.httpRequestDurationSeconds.observe(
      { method: 'GET', route: '/api/v1/resources/:id', status_code: '200' },
      0.01,
    );
    registry.httpRequestsTotal.inc({
      method: 'GET',
      route: '/api/v1/resources/:id',
      status_code: '200',
    });
    registry.cacheOperationsTotal.inc({ operation: 'get', result: 'hit' });
    registry.cacheOperationDurationSeconds.observe({ operation: 'get' }, 0.001);
    registry.dbQueryDurationSeconds.observe({ operation: 'select' }, 0.005);
    registry.dbPoolSize.set({ state: 'idle' }, 5);
    registry.dbQueryErrorsTotal.inc({ operation: 'insert', error_class: 'unique_violation' });
    registry.resourcesOperationsTotal.inc({ operation: 'create', outcome: 'success' });

    const output = await registry.render();

    expect(output).toContain('http_request_duration_seconds');
    expect(output).toContain('http_requests_total');
    expect(output).toContain('cache_operations_total');
    expect(output).toContain('cache_operation_duration_seconds');
    expect(output).toContain('db_query_duration_seconds');
    expect(output).toContain('db_pool_size');
    expect(output).toContain('db_query_errors_total');
    expect(output).toContain('resources_operations_total');
  });

  it('emits valid Prometheus exposition format (HELP + TYPE lines)', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    registry.httpRequestsTotal.inc({ method: 'GET', route: '/healthz', status_code: '200' });

    const output = await registry.render();

    expect(output).toMatch(/^# HELP http_requests_total /m);
    expect(output).toMatch(/^# TYPE http_requests_total counter/m);
  });

  it('records labels with the exact allowed label names', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    registry.httpRequestDurationSeconds.observe(
      { method: 'POST', route: '/api/v1/resources', status_code: '201' },
      0.02,
    );

    const output = await registry.render();

    // One exemplar sample line should contain all three labels together.
    expect(output).toMatch(
      /http_request_duration_seconds[^}]*method="POST"[^}]*route="\/api\/v1\/resources"[^}]*status_code="201"/,
    );
  });

  it('collectDefaults=true emits Node.js process metrics', async () => {
    const registry = new MetricsRegistry({ collectDefaults: true });
    const output = await registry.render();

    expect(output).toContain('process_cpu_user_seconds_total');
    expect(output).toContain('nodejs_heap_size_used_bytes');
  });

  it('collectDefaults=false omits Node.js process metrics', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    // Touch one custom metric so the registry is non-empty.
    registry.httpRequestsTotal.inc({ method: 'GET', route: '/x', status_code: '200' });

    const output = await registry.render();

    expect(output).not.toContain('process_cpu_user_seconds_total');
    expect(output).not.toContain('nodejs_heap_size_used_bytes');
  });

  it('reset() zeros values but keeps metrics registered', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    registry.httpRequestsTotal.inc({ method: 'GET', route: '/x', status_code: '200' });

    const before = await registry.render();
    expect(before).toMatch(/http_requests_total\{[^}]*\} 1/);

    registry.reset();

    // After reset, incrementing still works because the metric is still
    // registered (unlike clear()). The counter starts from zero again.
    registry.httpRequestsTotal.inc({ method: 'GET', route: '/x', status_code: '200' });
    const after = await registry.render();
    expect(after).toMatch(/http_requests_total\{[^}]*\} 1/);
  });

  it('clear() drops registrations (use at shutdown, not between tests)', async () => {
    const registry = new MetricsRegistry({ collectDefaults: false });
    registry.httpRequestsTotal.inc({ method: 'GET', route: '/x', status_code: '200' });

    const before = await registry.render();
    expect(before).toContain('http_requests_total');

    registry.clear();
    const after = await registry.render();
    expect(after).not.toContain('http_requests_total');
  });
});
