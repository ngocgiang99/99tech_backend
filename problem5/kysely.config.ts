import { defineConfig } from 'kysely-ctl';
import pg from 'pg';

// kysely.config.ts is loaded at runtime by kysely-ctl
// DATABASE_URL must be set in the environment (or .env)
const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for migrations');
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

export default defineConfig({
  dialect: 'pg',
  dialectConfig: { pool },
  migrations: {
    migrationFolder: 'migrations',
  },
});
