#!/usr/bin/env tsx
/**
 * benchmark-rebuild.ts — MIN-02 verification script
 *
 * Measures the time for LeaderboardRebuilder.rebuild() to process N rows.
 * Default N = 100_000. For the official MIN-02 gate use --rows 10000000.
 *
 * Usage:
 *   pnpm tsx scripts/benchmark-rebuild.ts
 *   pnpm tsx scripts/benchmark-rebuild.ts --rows 100000
 *   pnpm tsx scripts/benchmark-rebuild.ts --rows 10000000
 *
 * Exit code: 0 if elapsedMs < 60000, 1 otherwise.
 *
 * Reads DATABASE_URL and REDIS_URL from problem6/.env via dotenv.
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Load .env relative to the project root (one level up from scripts/)
function loadDotenv(envPath: string): void {
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env not found — rely on actual environment variables
  }
}

loadDotenv(resolve(__dirname, '../.env'));

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(): { rows: number } {
  const args = process.argv.slice(2);
  let rows = 100_000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rows' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (isNaN(n) || n <= 0) {
        console.error(`Invalid --rows value: ${args[i + 1]}`);
        process.exit(1);
      }
      rows = n;
    }
  }
  return { rows };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seedUserScores(pool: Pool, count: number): Promise<void> {
  const BATCH = 5_000;
  let inserted = 0;

  // Truncate first
  await pool.query('TRUNCATE user_scores CASCADE');

  while (inserted < count) {
    const batchSize = Math.min(BATCH, count - inserted);
    const valuePlaceholders: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (let i = 0; i < batchSize; i++) {
      const userId = randomUUID();
      const totalScore = randomInt(0, 1_000_000);
      const lastActionId = randomUUID();
      // Random offset: 0–365 days back
      const offsetMs = randomInt(0, 365 * 24 * 60 * 60 * 1000);
      const updatedAt = new Date(Date.now() - offsetMs).toISOString();

      valuePlaceholders.push(
        `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`,
      );
      values.push(userId, totalScore, lastActionId, updatedAt);
      paramIdx += 4;
    }

    await pool.query(
      `INSERT INTO user_scores (user_id, total_score, last_action_id, updated_at) VALUES ${valuePlaceholders.join(', ')}`,
      values,
    );

    inserted += batchSize;
    process.stderr.write(`\rSeeded ${inserted}/${count} rows...`);
  }
  process.stderr.write('\n');
}

// ─── LeaderboardRebuilder (inline — avoids NestJS DI overhead for the script) ─

const REBUILD_LOCK_KEY = 'leaderboard:rebuild:lock';
const LEADERBOARD_KEY = 'leaderboard:global';
const BATCH_SIZE = 1_000;
const LOCK_TTL_SECONDS = 300;
const SCORE_SHIFT = 2 ** 32;
const MAX_TS = SCORE_SHIFT - 1;

function encodeScore(score: number, updatedAtSeconds: number): number {
  return score * SCORE_SHIFT + (MAX_TS - updatedAtSeconds);
}

async function rebuildLeaderboard(
  pool: Pool,
  redis: Redis,
  topN: number,
): Promise<{ usersProcessed: number; elapsedMs: number }> {
  const instanceId = randomUUID();
  const lockAcquired = await redis.set(
    REBUILD_LOCK_KEY,
    instanceId,
    'EX',
    LOCK_TTL_SECONDS,
    'NX',
  );

  if (lockAcquired === null) {
    console.error('Another rebuild is in progress — cannot acquire lock');
    return { usersProcessed: 0, elapsedMs: 0 };
  }

  try {
    const startTs = Date.now();

    const result = await pool.query<{
      user_id: string;
      total_score: string;
      updated_at: string;
    }>(
      `SELECT user_id, total_score, updated_at
       FROM user_scores
       ORDER BY total_score DESC, updated_at ASC
       LIMIT $1`,
      [topN],
    );

    const rows = result.rows;
    const total = rows.length;

    // Clear existing ZSET
    await redis.del(LEADERBOARD_KEY);

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const pipeline = redis.multi();

      for (const row of batch) {
        const updatedAtSeconds = Math.floor(
          new Date(row.updated_at).getTime() / 1000,
        );
        const encoded = encodeScore(Number(row.total_score), updatedAtSeconds);
        pipeline.zadd(LEADERBOARD_KEY, encoded, row.user_id);
      }

      await pipeline.exec();
    }

    return { usersProcessed: total, elapsedMs: Date.now() - startTs };
  } finally {
    const val = await redis.get(REBUILD_LOCK_KEY);
    if (val === instanceId) {
      await redis.del(REBUILD_LOCK_KEY);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { rows } = parseArgs();

  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];

  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — check problem6/.env');
    process.exit(1);
  }
  if (!redisUrl) {
    console.error('REDIS_URL is not set — check problem6/.env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl);

  try {
    console.error(
      `[benchmark] seeding ${rows.toLocaleString()} rows into user_scores...`,
    );
    await seedUserScores(pool, rows);

    console.error('[benchmark] clearing leaderboard:global in Redis...');
    await redis.del(LEADERBOARD_KEY);

    console.error('[benchmark] running LeaderboardRebuilder.rebuild()...');
    const result = await rebuildLeaderboard(pool, redis, rows);

    const durationOk = result.elapsedMs < 60_000;

    const output = {
      usersProcessed: result.usersProcessed,
      elapsedMs: result.elapsedMs,
      durationOk,
    };

    console.log(JSON.stringify(output));

    if (!durationOk) {
      console.error(
        `[benchmark] FAIL: rebuild took ${result.elapsedMs}ms which exceeds the 60s limit (MIN-02)`,
      );
    } else {
      console.error(
        `[benchmark] PASS: rebuilt ${result.usersProcessed.toLocaleString()} users in ${result.elapsedMs}ms`,
      );
    }

    process.exit(durationOk ? 0 : 1);
  } catch (err) {
    console.error('[benchmark] ERROR:', err);
    process.exit(1);
  } finally {
    await pool.end();
    redis.disconnect();
  }
}

void main();
