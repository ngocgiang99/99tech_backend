import pg from 'pg';
import { Kysely, PostgresDialect, type LogConfig } from 'kysely';

import type { Database } from './schema.js';

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
  /**
   * Optional Kysely log config (a `Logger` callback or a list of levels).
   * Used by `src/observability/db-metrics.ts` to receive every query and
   * error event with duration already computed by the driver.
   */
  log?: LogConfig;
}

export interface DbClient {
  db: Kysely<Database>;
  pool: pg.Pool;
}

export function createDb(config: DbConfig): DbClient {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    ...(config.log ? { log: config.log } : {}),
  });

  return { db, pool };
}
