import type { LogEvent } from 'kysely';

import type { MetricsRegistry } from './metrics-registry.js';

type DbOperation = 'select' | 'insert' | 'update' | 'delete' | 'other';

/**
 * Map a Kysely root operation node kind to the bounded `operation` label.
 * Anything outside the four CRUD verbs (raw queries, transactions, schema
 * DDL, etc.) is collapsed to `other` to keep cardinality bounded.
 */
function mapNodeKindToOperation(kind: string | undefined): DbOperation {
  switch (kind) {
    case 'SelectQueryNode':
      return 'select';
    case 'InsertQueryNode':
      return 'insert';
    case 'UpdateQueryNode':
      return 'update';
    case 'DeleteQueryNode':
      return 'delete';
    default:
      return 'other';
  }
}

/**
 * Postgres SQLSTATE → bounded error class allowlist. Anything not listed
 * collapses to `other`. Source:
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
function mapPgErrorClass(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'other';
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return 'other';

  switch (code) {
    case '23505':
      return 'unique_violation';
    case '23502':
      return 'not_null_violation';
    case '23503':
      return 'foreign_key_violation';
    case '23514':
      return 'check_violation';
    case '40P01':
      return 'deadlock';
    case '40001':
      return 'serialization_failure';
    case '08006':
    case '08001':
    case '08004':
      return 'connection_failure';
    case '42601':
      return 'syntax_error';
    case '42P01':
      return 'undefined_table';
    case '42703':
      return 'undefined_column';
    default:
      return 'other';
  }
}

/**
 * Build a Kysely `log` callback that records every query's duration into
 * `db_query_duration_seconds` and every query error into `db_query_errors_total`.
 *
 * Why a `log` callback instead of a `KyselyPlugin`:
 * - The plugin's `transformResult` is NOT called on errors, so error tracking
 *   from a plugin is unreliable (the Kysely docs explicitly warn about this).
 * - The log callback receives both `query` and `error` events with the
 *   duration already computed by the driver — no `WeakMap` bookkeeping.
 * - It does not transform queries, so it has zero risk of altering behavior.
 */
export function createDbMetricsLogger(
  metrics: MetricsRegistry,
): (event: LogEvent) => void {
  return (event: LogEvent) => {
    const operation = mapNodeKindToOperation(event.query.query.kind);

    if (operation === 'other') {
      // Skip non-CRUD nodes (raw, with, etc.) — they don't fit the bounded
      // operation label and we don't want to inflate the histogram with them.
      return;
    }

    const durationSeconds = event.queryDurationMillis / 1000;
    metrics.dbQueryDurationSeconds.observe({ operation }, durationSeconds);

    if (event.level === 'error') {
      const errorClass = mapPgErrorClass(event.error);
      metrics.dbQueryErrorsTotal.inc({ operation, error_class: errorClass });
    }
  };
}
