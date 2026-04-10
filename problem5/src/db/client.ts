import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

import type { Database } from './schema.js';

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
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
  });

  return { db, pool };
}
