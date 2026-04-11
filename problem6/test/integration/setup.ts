import path from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { FileMigrationProvider, Kysely, Migrator, PostgresDialect } from 'kysely';
import * as fs from 'node:fs/promises';
import { Pool } from 'pg';

import type { Database } from '../../src/database/database.factory';
import type { DB } from '../../src/database/types.generated';

export interface PostgresHandle {
  container: StartedPostgreSqlContainer;
  url: string;
  db: Database;
}

export interface RedisHandle {
  container: StartedRedisContainer;
  client: Redis;
}

export async function startPostgres(): Promise<PostgresHandle> {
  const container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

  const pool = new Pool({ connectionString: url });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  const migrationsDir = path.join(__dirname, '../../src/database/migrations');
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: migrationsDir,
    }),
  });

  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
  if (results) {
    for (const r of results) {
      if (r.status === 'Error') {
        throw new Error(`Migration ${r.migrationName} failed`);
      }
    }
  }

  return { container, url, db };
}

export async function startRedis(): Promise<RedisHandle> {
  const container = await new RedisContainer('redis:7').start();
  const client = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    lazyConnect: false,
  });
  return { container, client };
}
