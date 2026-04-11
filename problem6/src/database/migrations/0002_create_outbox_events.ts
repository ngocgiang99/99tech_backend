import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('outbox_events')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('aggregate_id', 'uuid', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('published_at', 'timestamptz')
    .execute();

  // Partial index on unpublished events — keeps the outbox publisher's scan fast.
  await db.schema
    .createIndex('idx_outbox_unpublished')
    .on('outbox_events')
    .column('id')
    .where(sql.ref('published_at'), 'is', null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_outbox_unpublished').execute();
  await db.schema.dropTable('outbox_events').execute();
}
