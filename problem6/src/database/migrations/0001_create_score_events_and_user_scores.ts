import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('score_events')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('action_id', 'uuid', (col) => col.notNull())
    .addColumn('delta', 'integer', (col) =>
      col.notNull().check(sql`delta > 0`),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('uq_score_events_action', ['action_id'])
    .execute();

  await db.schema
    .createIndex('idx_score_events_user_created')
    .on('score_events')
    .columns(['user_id', 'created_at desc'])
    .execute();

  await db.schema
    .createTable('user_scores')
    .addColumn('user_id', 'uuid', (col) => col.primaryKey())
    .addColumn('total_score', 'bigint', (col) =>
      col.notNull().defaultTo(0).check(sql`total_score >= 0`),
    )
    .addColumn('last_action_id', 'uuid')
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_user_scores_total_updated')
    .on('user_scores')
    .columns(['total_score desc', 'updated_at asc'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('user_scores').execute();
  await db.schema.dropTable('score_events').execute();
}
