import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type Redis from 'ioredis';

import type { Database } from '../../../src/db/schema.js';

/**
 * Wipes the resources table between tests. Preferred over rollback because
 * the repository methods don't open their own transactions.
 */
export async function resetDatabase(db: Kysely<Database>): Promise<void> {
  await sql`TRUNCATE TABLE resources RESTART IDENTITY`.execute(db);
}

/**
 * Wipes the Redis test DB between tests. Uses FLUSHDB (current DB only)
 * so it's safe even if something else is pointed at the same instance.
 */
export async function flushCache(redis: Redis): Promise<void> {
  await redis.flushdb();
}
