import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { ConfigService } from '../config';

import type { DB } from './types.generated';

export type Database = Kysely<DB>;

export function buildDatabase(config: ConfigService): Database {
  const pool = new Pool({
    connectionString: config.get('DATABASE_URL'),
  });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });
}
