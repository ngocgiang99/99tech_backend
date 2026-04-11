import { defineConfig } from 'kysely-ctl';
import pg from 'pg';

// kysely.config.ts is loaded at runtime by kysely-ctl
// DATABASE_URL must be set in the environment (or .env)
const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for migrations');
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// UTC datetime prefix: YYYYMMDD_HHMMSS_
// Kysely sorts migrations lexicographically, so this yields chronological order.
// The pre-existing numeric file (0001_create_resources.ts) still sorts before any
// datetime-prefixed file, so legacy migrations remain safe.
const pad = (n: number): string => String(n).padStart(2, '0');
const datetimeMigrationPrefix = (): string => {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}_`
  );
};

export default defineConfig({
  dialect: 'pg',
  dialectConfig: { pool },
  migrations: {
    migrationFolder: 'migrations',
    getMigrationPrefix: datetimeMigrationPrefix,
  },
});
