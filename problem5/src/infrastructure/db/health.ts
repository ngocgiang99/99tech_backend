import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { CheckResult } from '../../shared/health.js';

import type { Database } from './schema.js';

export function dbHealthCheck(db: Kysely<Database>): () => Promise<CheckResult> {
  return async (): Promise<CheckResult> => {
    try {
      await Promise.race([
        sql`SELECT 1`.execute(db),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DB health check timeout')), 1000),
        ),
      ]);
      return { status: 'up' };
    } catch (err) {
      return {
        status: 'down',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
