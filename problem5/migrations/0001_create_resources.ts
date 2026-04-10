import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Enable pgcrypto for gen_random_uuid()
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  // Create resources table
  await db.schema
    .createTable('resources')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull(),
    )
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('type', 'varchar(64)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('active'))
    .addColumn('tags', sql`text[]`, (col) => col.notNull().defaultTo(sql`ARRAY[]::text[]`))
    .addColumn('owner_id', 'uuid', (col) => col)
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Index: keyset pagination (created_at DESC, id DESC)
  await db.schema
    .createIndex('resources_created_at_id_idx')
    .on('resources')
    .columns(['created_at desc', 'id desc'])
    .execute();

  // Index: type filter
  await db.schema
    .createIndex('resources_type_idx')
    .on('resources')
    .column('type')
    .execute();

  // Index: status filter
  await db.schema
    .createIndex('resources_status_idx')
    .on('resources')
    .column('status')
    .execute();

  // Index: owner_id filter
  await db.schema
    .createIndex('resources_owner_id_idx')
    .on('resources')
    .column('owner_id')
    .execute();

  // GIN index: tags containment (@>)
  await sql`CREATE INDEX IF NOT EXISTS resources_tags_gin_idx ON resources USING gin(tags)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('resources').ifExists().execute();
}
