/**
 * Benchmark seed script — pre-populates the resources table with a
 * deterministic pool of rows and writes their UUIDs to ids.json for use
 * by k6 SharedArray in read scenarios.
 *
 * Usage:
 *   tsx benchmarks/seed/seed.ts [--count <n>] [--clear]
 *
 * Options:
 *   --count <n>   Number of rows to ensure exist (default: 10000)
 *   --clear       Truncate the resources table before inserting
 *
 * Env:
 *   DATABASE_URL  Required. PostgreSQL connection string.
 *
 * Design notes (see openspec/changes/s05-add-benchmarks-k6/design.md):
 *   - Uses `pg` Pool directly (not Kysely) so this script has no compile step
 *     and remains standalone — it runs via `tsx` without the full project DI.
 *   - Inserts in batches of 500 to avoid parameter-count limits and to give
 *     reasonable progress feedback for large pools.
 *   - Idempotent when `--clear` is absent: counts existing rows and skips if
 *     the table already has >= --count rows.
 *   - Writes ids.json next to this file so k6 scenarios can load it via
 *     SharedArray without a network round-trip.
 */

import { createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { count: number; clear: boolean } {
  const args = process.argv.slice(2);
  let count = 10_000;
  let clear = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed < 1) {
        console.error(`--count must be a positive integer, got: ${args[i + 1]}`);
        process.exit(1);
      }
      count = parsed;
      i++;
    } else if (args[i] === '--clear') {
      clear = true;
    }
  }

  return { count, clear };
}

// ---------------------------------------------------------------------------
// Data generation helpers
// ---------------------------------------------------------------------------

const RESOURCE_TYPES = ['server', 'database', 'storage', 'network', 'compute', 'cache', 'queue'];
const RESOURCE_STATUSES = ['active', 'inactive', 'pending'];
const TAG_POOL = ['prod', 'dev', 'staging', 'us-east-1', 'us-west-2', 'eu-west-1', 'critical', 'monitored'];

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomTags(): string[] {
  const count = Math.floor(Math.random() * 4); // 0-3 tags
  const selected = new Set<string>();
  for (let i = 0; i < count; i++) {
    selected.add(randomElement(TAG_POOL));
  }
  return Array.from(selected);
}

interface ResourceRow {
  id: string;
  name: string;
  type: string;
  status: string;
  tags: string[];
  owner_id: string | null;
  metadata: Record<string, unknown>;
}

function generateRow(index: number): ResourceRow {
  const id = uuidv4();
  const type = randomElement(RESOURCE_TYPES);
  return {
    id,
    name: `bench-${type}-${index.toString().padStart(6, '0')}`,
    type,
    status: randomElement(RESOURCE_STATUSES),
    tags: randomTags(),
    owner_id: Math.random() > 0.3 ? uuidv4() : null,
    metadata: { bench: true, index },
  };
}

// ---------------------------------------------------------------------------
// Batch insert
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

async function insertBatch(pool: pg.Pool, rows: ResourceRow[]): Promise<void> {
  if (rows.length === 0) return;

  // Build a multi-row VALUES clause with $1, $2, … placeholders.
  // Each row has 7 parameters.
  const PARAMS_PER_ROW = 7;
  const valueClauses: string[] = [];
  const params: unknown[] = [];

  rows.forEach((row, i) => {
    const base = i * PARAMS_PER_ROW;
    valueClauses.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::text[], $${base + 6}, $${base + 7}::jsonb)`,
    );
    params.push(
      row.id,
      row.name,
      row.type,
      row.status,
      `{${row.tags.map((t) => `"${t}"`).join(',')}}`,
      row.owner_id,
      JSON.stringify(row.metadata),
    );
  });

  const sql = `
    INSERT INTO resources (id, name, type, status, tags, owner_id, metadata)
    VALUES ${valueClauses.join(', ')}
    ON CONFLICT (id) DO NOTHING
  `;

  await pool.query(sql, params);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { count, clear } = parseArgs();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Verify connectivity
    await pool.query('SELECT 1');
    console.log('Connected to Postgres');

    // Optional truncate
    if (clear) {
      console.log('--clear flag set: truncating resources table...');
      await pool.query('TRUNCATE TABLE resources RESTART IDENTITY CASCADE');
      console.log('Table truncated.');
    }

    // Idempotency check: count existing rows
    const countResult = await pool.query<{ cnt: string }>('SELECT COUNT(*) AS cnt FROM resources WHERE (metadata->>\'bench\')::boolean = true');
    const existing = parseInt(countResult.rows[0].cnt, 10);
    console.log(`Existing bench rows: ${existing} / ${count} target`);

    if (!clear && existing >= count) {
      console.log(`Already have ${existing} bench rows (>= ${count}). Collecting existing IDs...`);
      const idsResult = await pool.query<{ id: string }>(
        `SELECT id FROM resources WHERE (metadata->>'bench')::boolean = true ORDER BY created_at LIMIT $1`,
        [count],
      );
      const ids = idsResult.rows.map((r) => r.id);
      await writeIds(ids);
      console.log(`ids.json written with ${ids.length} IDs (no new inserts needed).`);
      return;
    }

    // How many rows to insert
    const toInsert = clear ? count : count - existing;
    console.log(`Inserting ${toInsert} new rows in batches of ${BATCH_SIZE}...`);

    const allIds: string[] = [];

    // Collect already-existing IDs first (when not clearing)
    if (!clear && existing > 0) {
      const idsResult = await pool.query<{ id: string }>(
        `SELECT id FROM resources WHERE (metadata->>'bench')::boolean = true ORDER BY created_at`,
      );
      idsResult.rows.forEach((r) => allIds.push(r.id));
    }

    let inserted = 0;
    while (inserted < toInsert) {
      const batchSize = Math.min(BATCH_SIZE, toInsert - inserted);
      const batch: ResourceRow[] = [];
      for (let i = 0; i < batchSize; i++) {
        batch.push(generateRow(existing + inserted + i));
      }
      await insertBatch(pool, batch);
      batch.forEach((r) => allIds.push(r.id));
      inserted += batchSize;

      const pct = Math.round((inserted / toInsert) * 100);
      process.stdout.write(`\r  Inserted ${inserted}/${toInsert} (${pct}%)`);
    }
    console.log(); // newline after progress

    await writeIds(allIds);
    console.log(`Done. ids.json written with ${allIds.length} IDs.`);
  } finally {
    await pool.end();
  }
}

async function writeIds(ids: string[]): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const outPath = resolve(__dirname, 'ids.json');

  return new Promise((resolve_fn, reject) => {
    const ws = createWriteStream(outPath);
    ws.write(JSON.stringify(ids, null, 2));
    ws.end();
    ws.on('finish', () => resolve_fn());
    ws.on('error', reject);
  });
}

main().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
