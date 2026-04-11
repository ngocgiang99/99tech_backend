import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

// Label allowlists. Encoded as `as const` tuples so they're greppable and
// the type system flags any drift between the spec and the code.
//
// Cardinality discipline: every label value the service emits MUST come from
// one of these tuples (or a constant sentinel like '__unmatched' / 'other').
// User-controlled values (URL paths, header values, error messages) NEVER
// flow into a label directly. See ARCHITECTURE.md §Observability.

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD', 'OPTIONS'] as const;

export const CACHE_OPERATIONS = ['get', 'set', 'del', 'incr'] as const;
export const CACHE_RESULTS = ['hit', 'miss', 'error'] as const;

export const DB_OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;

// Postgres error class allowlist. Anything not in this set collapses to 'other'.
// Source: https://www.postgresql.org/docs/current/errcodes-appendix.html
export const DB_ERROR_CLASSES = [
  'unique_violation',     // 23505
  'not_null_violation',   // 23502
  'foreign_key_violation', // 23503
  'check_violation',      // 23514
  'deadlock',             // 40P01
  'serialization_failure', // 40001
  'connection_failure',   // 08006
  'syntax_error',         // 42601
  'undefined_table',      // 42P01
  'undefined_column',     // 42703
  'other',
] as const;

export const DB_POOL_STATES = ['total', 'idle', 'waiting'] as const;

export const RESOURCES_OPERATIONS = ['create', 'read', 'list', 'update', 'delete'] as const;
export const RESOURCES_OUTCOMES = ['success', 'not_found', 'validation_error', 'error'] as const;

export interface MetricsRegistryOptions {
  collectDefaults: boolean;
}

/**
 * Owns the single `prom-client.Registry` instance and exposes typed factories
 * for every custom metric the service emits. Pass this object as a constructor
 * dependency to the HTTP middleware, the cached repository, the Kysely plugin,
 * and the resources controller — never import the registry as a module-level
 * singleton (it makes testing impossible).
 */
export class MetricsRegistry {
  readonly registry: Registry;

  readonly httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status_code'>;
  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status_code'>;

  readonly cacheOperationsTotal: Counter<'operation' | 'result'>;
  readonly cacheOperationDurationSeconds: Histogram<'operation'>;

  readonly dbQueryDurationSeconds: Histogram<'operation'>;
  readonly dbPoolSize: Gauge<'state'>;
  readonly dbQueryErrorsTotal: Counter<'operation' | 'error_class'>;

  readonly resourcesOperationsTotal: Counter<'operation' | 'outcome'>;

  constructor(opts: MetricsRegistryOptions) {
    this.registry = new Registry();

    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, by method, matched route pattern, and status code.',
      labelNames: ['method', 'route', 'status_code'] as const,
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests served, by method, matched route pattern, and status code.',
      labelNames: ['method', 'route', 'status_code'] as const,
      registers: [this.registry],
    });

    this.cacheOperationsTotal = new Counter({
      name: 'cache_operations_total',
      help: 'Cache operations on the resource cached repository, by operation and result.',
      labelNames: ['operation', 'result'] as const,
      registers: [this.registry],
    });

    this.cacheOperationDurationSeconds = new Histogram({
      name: 'cache_operation_duration_seconds',
      help: 'Cache operation latency in seconds, by operation.',
      labelNames: ['operation'] as const,
      registers: [this.registry],
    });

    this.dbQueryDurationSeconds = new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Database query latency in seconds, by operation kind (select|insert|update|delete).',
      labelNames: ['operation'] as const,
      registers: [this.registry],
    });

    this.dbPoolSize = new Gauge({
      name: 'db_pool_size',
      help: 'pg.Pool connection counts, by state (total|idle|waiting). Sampled every 5s.',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });

    this.dbQueryErrorsTotal = new Counter({
      name: 'db_query_errors_total',
      help: 'Database query errors by operation kind and bounded error class.',
      labelNames: ['operation', 'error_class'] as const,
      registers: [this.registry],
    });

    this.resourcesOperationsTotal = new Counter({
      name: 'resources_operations_total',
      help: 'Resources CRUD operations at the domain layer, by operation and outcome.',
      labelNames: ['operation', 'outcome'] as const,
      registers: [this.registry],
    });

    if (opts.collectDefaults) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  /** Serialize the registry to Prometheus exposition format. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Zero out every registered metric's value without un-registering them.
   * Used in tests to isolate metric state between cases.
   *
   * NOTE: this is NOT `registry.clear()`. `clear()` wipes the metric
   * definitions themselves, after which subsequent `.inc()`/`.observe()`
   * calls on the bound instances become no-ops from the registry's
   * perspective — the instances still mutate their internal state, but
   * the registry's serializer has no handle to them anymore.
   */
  reset(): void {
    this.registry.resetMetrics();
  }

  /**
   * Drop every metric registration. Used in shutdown paths where the
   * registry should be torn down completely; NOT safe to call between
   * tests that share the same registry instance.
   */
  clear(): void {
    this.registry.clear();
  }
}
