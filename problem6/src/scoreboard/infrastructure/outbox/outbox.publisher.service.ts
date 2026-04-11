import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { DATABASE, type Database } from '../../../database';
import { ConfigService } from '../../../config';
import {
  DOMAIN_EVENT_PUBLISHER,
  type DomainEventPublisher,
  LEADERBOARD_CACHE_TOKEN,
  type LeaderboardCache,
  type LeaderboardEntry,
} from '../../domain';

const OUTBOX_LOCK_KEY = 'outbox:lock';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
  published_at: Date | string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly instanceId = randomUUID();

  private running = false;
  private isLeader = false;
  private shutdownCompleted = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastPublishedTop10: string | null = null;
  private leaderboardBuffer: OutboxRow[] = [];
  private lastWindow = 0;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject('Redis') private readonly redis: Redis,
    @Inject(DOMAIN_EVENT_PUBLISHER)
    private readonly publisher: DomainEventPublisher,
    @Inject(LEADERBOARD_CACHE_TOKEN)
    private readonly cache: LeaderboardCache,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    void this.runOuterLoop();
    this.logger.log(
      { instanceId: this.instanceId },
      'outbox publisher started',
    );
  }

  private async runOuterLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tryAcquireLeadership();
      } catch (e) {
        this.logger.error({ err: e }, 'outbox outer loop error');
        await sleep(5000);
      }
    }
  }

  private async tryAcquireLeadership(): Promise<void> {
    const ttl = this.config.get('OUTBOX_LOCK_TTL_SECONDS');
    const acquired = await this.redis.set(
      OUTBOX_LOCK_KEY,
      this.instanceId,
      'EX',
      ttl,
      'NX',
    );

    if (acquired === null) {
      await sleep(5000);
      return;
    }

    this.isLeader = true;
    this.logger.log({ instanceId: this.instanceId }, 'outbox leader acquired');
    this.startHeartbeat();

    try {
      await this.runInnerLoop();
    } finally {
      this.isLeader = false;
      this.stopHeartbeat();
      this.logger.log(
        { instanceId: this.instanceId },
        'outbox leader relinquished',
      );
    }
  }

  private startHeartbeat(): void {
    const ttl = this.config.get('OUTBOX_LOCK_TTL_SECONDS');
    const heartbeatMs = (ttl / 2) * 1000;

    this.heartbeatInterval = setInterval(() => {
      void (async () => {
        try {
          // Extend only if we still hold the lock: SET XX means "only update if key exists"
          // We first verify the value matches to guard against a race where the lock expired
          // and was re-acquired by another instance.
          const currentVal = await this.redis.get(OUTBOX_LOCK_KEY);
          if (currentVal !== this.instanceId) {
            this.logger.warn(
              { instanceId: this.instanceId },
              'outbox lost lock during heartbeat — stopping inner loop',
            );
            this.isLeader = false;
            return;
          }
          const ok = await this.redis.set(
            OUTBOX_LOCK_KEY,
            this.instanceId,
            'EX',
            ttl,
            'XX',
          );
          if (ok === null) {
            this.logger.warn(
              { instanceId: this.instanceId },
              'outbox lock renewal failed (XX returned null)',
            );
            this.isLeader = false;
          }
        } catch (e) {
          this.logger.error({ err: e }, 'outbox heartbeat failed');
        }
      })();
    }, heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async runInnerLoop(): Promise<void> {
    const pollMs = this.config.get('OUTBOX_POLL_INTERVAL_MS');
    while (this.running && this.isLeader) {
      try {
        await this.publishBatch();
      } catch (e) {
        this.logger.error({ err: e }, 'publishBatch failed');
      }
      await sleep(pollMs);
    }
  }

  private async publishBatch(): Promise<void> {
    const rows = (await this.db
      .selectFrom('outbox_events')
      .where('published_at', 'is', null)
      .orderBy('id')
      .limit(100)
      .selectAll()
      .execute()) as OutboxRow[];

    if (rows.length === 0) {
      return;
    }

    // Split by event type
    const credited = rows.filter(
      (r) => r.event_type === 'scoreboard.score.credited',
    );
    const leaderboardUpdated = rows.filter(
      (r) => r.event_type === 'scoreboard.leaderboard.updated',
    );

    // 1:1 publish for score.credited
    for (const row of credited) {
      try {
        const payload =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : (row.payload as Record<string, unknown>);

        await this.publisher.publish(
          { subject: row.event_type, payload },
          { msgId: String(row.id) },
        );
        await this.db
          .updateTable('outbox_events')
          .set({ published_at: new Date() })
          .where('id', '=', row.id)
          .execute();
      } catch (e) {
        this.logger.error(
          { err: e, rowId: row.id },
          'credited publish failed — will retry',
        );
        // Do NOT set published_at — row will be retried on next poll
      }
    }

    // Accumulate leaderboard.updated rows in the coalescing buffer
    this.leaderboardBuffer.push(...leaderboardUpdated);

    const windowMs = this.config.get('OUTBOX_COALESCE_WINDOW_MS');
    const currentWindow = Math.floor(Date.now() / windowMs) * windowMs;

    if (
      currentWindow !== this.lastWindow &&
      this.leaderboardBuffer.length > 0
    ) {
      await this.drainLeaderboardWindow();
      this.lastWindow = currentWindow;
    }
  }

  private async drainLeaderboardWindow(): Promise<void> {
    const buffered = this.leaderboardBuffer;
    this.leaderboardBuffer = [];

    let top: LeaderboardEntry[];
    try {
      top = await this.cache.getTop(10);
    } catch (e) {
      this.logger.error(
        { err: e },
        'cache.getTop failed — requeueing buffered rows',
      );
      this.leaderboardBuffer.unshift(...buffered);
      return;
    }

    const topJson = JSON.stringify(top);

    if (topJson !== this.lastPublishedTop10) {
      try {
        // Use the max buffered row.id as the dedup msgId — monotonic and ties the publish to a specific batch
        const maxId = buffered.reduce(
          (max, r) => (Number(r.id) > max ? Number(r.id) : max),
          0,
        );
        const msgId = String(maxId);

        await this.publisher.publish(
          {
            subject: 'scoreboard.leaderboard.updated',
            payload: { top: top as unknown as Record<string, unknown> },
          },
          { msgId },
        );
        this.lastPublishedTop10 = topJson;
      } catch (e) {
        this.logger.error(
          { err: e },
          'coalesced leaderboard publish failed — requeueing buffered rows',
        );
        // Put buffered rows back so next poll picks them up
        this.leaderboardBuffer.unshift(...buffered);
        return;
      }
    }

    // Mark all buffered rows as published (covered by the one publish, or skipped as no-op)
    const ids = buffered.map((r) => r.id);
    if (ids.length > 0) {
      await this.db
        .updateTable('outbox_events')
        .set({ published_at: new Date() })
        .where('id', 'in', ids)
        .execute();
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.shutdownCompleted) {
      return;
    }
    this.shutdownCompleted = true;
    this.logger.log(
      { instanceId: this.instanceId, signal },
      'outbox publisher shutting down',
    );
    this.running = false;

    // Wait for inner loop to finish (max 30s)
    const start = Date.now();
    while (this.isLeader && Date.now() - start < 30_000) {
      await sleep(100);
    }

    this.stopHeartbeat();

    // Release lock if we still own it — value-matched delete (CAD pattern)
    try {
      const val = await this.redis.get(OUTBOX_LOCK_KEY);
      if (val === this.instanceId) {
        await this.redis.del(OUTBOX_LOCK_KEY);
      }
    } catch (e) {
      this.logger.warn({ err: e }, 'outbox lock release failed on shutdown');
    }

    this.logger.log(
      { signal, instanceId: this.instanceId, count: 0 },
      'outbox publisher stopped',
    );
  }
}
