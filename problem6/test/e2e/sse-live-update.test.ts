/**
 * E2E test: Full SSE live-update against docker-compose stack
 *
 * Prerequisites:
 *   - docker-compose stack is running: `mise run infra:up:full`
 *     (or at minimum `mise run infra:up` + API on :3000)
 *   - .env is populated with secrets matching the running stack
 *
 * Test flow:
 *   a. Build fixture JWT from INTERNAL_JWT_SECRET in .env
 *   b. Open SSE connection to GET /v1/leaderboard/stream
 *   c. POST /v1/actions:issue-token to get an Action-Token
 *   d. POST /v1/scores:increment with actionId + delta + Action-Token
 *   e. Await the SSE `leaderboard.updated` frame within 1000ms
 *   f. Assert payload shape
 *
 * If the stack is NOT running this test exits with a clear skip log line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as jose from 'jose';

jest.setTimeout(30_000);

// ─── Load .env ────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

// ─── SSE frame parser ────────────────────────────────────────────────────────

function parseSseFrames(text: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice('data: '.length).trim();
      }
    }
    if (data) {
      frames.push({ event, data });
    }
  }
  return frames;
}

// ─── Stack availability check ────────────────────────────────────────────────

async function isStackRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: SSE live-update (against docker-compose stack)', () => {
  const BASE_URL = 'http://localhost:3000';
  const env = loadEnv();

  const INTERNAL_JWT_SECRET =
    env['INTERNAL_JWT_SECRET'] ?? process.env['INTERNAL_JWT_SECRET'] ?? '';

  let skipReason: string | null = null;

  beforeAll(async () => {
    if (!INTERNAL_JWT_SECRET || INTERNAL_JWT_SECRET.length < 32) {
      skipReason =
        'INTERNAL_JWT_SECRET not set or too short — cannot build fixture JWT';
      console.warn(`[E2E SKIP] ${skipReason}`);
      return;
    }

    const running = await isStackRunning(BASE_URL);
    if (!running) {
      skipReason = `Docker-compose stack is not running at ${BASE_URL} — run \`mise run infra:up:full\` first`;
      console.warn(`[E2E SKIP] ${skipReason}`);
      return;
    }
  });

  test('POST scores:increment triggers SSE leaderboard.updated frame within 1000ms', async () => {
    if (skipReason) {
      console.warn(`[E2E SKIP] ${skipReason}`);
      return;
    }

    // Build fixture JWT
    const secret = new TextEncoder().encode(INTERNAL_JWT_SECRET);
    const userId = `e2e-sse-${Date.now()}`;
    const jwt = await new jose.SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);

    const abortController = new AbortController();
    const receivedFrames: Array<{ event: string; data: string }> = [];
    let buffer = '';

    // Open SSE connection
    const ssePromise = fetch(`${BASE_URL}/v1/leaderboard/stream`, {
      headers: { authorization: `Bearer ${jwt}` },
      signal: abortController.signal,
    })
      .then(async (res) => {
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const newFrames = parseSseFrames(buffer);
          receivedFrames.push(...newFrames);
          const lastSep = buffer.lastIndexOf('\n\n');
          if (lastSep !== -1) {
            buffer = buffer.slice(lastSep + 2);
          }
        }
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') throw err;
      });

    // Wait for initial snapshot
    const snapshotDeadline = Date.now() + 5_000;
    while (Date.now() < snapshotDeadline) {
      if (receivedFrames.some((f) => f.event === 'snapshot')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(receivedFrames.some((f) => f.event === 'snapshot')).toBe(true);

    // Issue action token
    const issueRes = await fetch(`${BASE_URL}/v1/actions:issue-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ actionType: 'level-complete' }),
    });
    expect(issueRes.status).toBe(200);
    const { actionId, actionToken } = (await issueRes.json()) as {
      actionId: string;
      actionToken: string;
      expiresAt: string;
      maxDelta: number;
    };

    // Record write timestamp for latency measurement
    const writeTs = Date.now();

    // Increment score
    const incrementRes = await fetch(`${BASE_URL}/v1/scores:increment`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'x-action-token': actionToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ actionId, delta: 50 }),
    });
    expect(incrementRes.status).toBe(200);

    // Wait for leaderboard.updated frame within 1000ms from write
    const updateDeadline = writeTs + 1_000;
    while (Date.now() < updateDeadline) {
      if (receivedFrames.some((f) => f.event === 'leaderboard.updated')) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    abortController.abort();
    await ssePromise;

    const gotUpdate = receivedFrames.some(
      (f) => f.event === 'leaderboard.updated',
    );
    if (!gotUpdate) {
      console.warn(
        `[E2E] leaderboard.updated frame not received within 1000ms from write — ` +
          `elapsed: ${Date.now() - writeTs}ms. This may indicate stack latency under load.`,
      );
    }
    expect(gotUpdate).toBe(true);

    // Assert payload shape
    const updateFrame = receivedFrames.find(
      (f) => f.event === 'leaderboard.updated',
    )!;
    const payload = JSON.parse(updateFrame.data) as { top: unknown[] };
    expect(payload.top).toBeDefined();
    expect(Array.isArray(payload.top)).toBe(true);
  });
});
