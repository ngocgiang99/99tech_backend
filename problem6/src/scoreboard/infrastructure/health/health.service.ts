import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { NatsConnection } from 'nats';
import type { Redis } from 'ioredis';

import { DATABASE, type Database } from '../../../database';
import { ReadinessService } from '../../../shared/readiness/readiness.service';

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

function timeout(ms: number): Promise<ProbeResult> {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms),
  );
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject('Redis') private readonly redis: Redis,
    @Inject('Nats') private readonly nats: NatsConnection,
    private readonly readiness: ReadinessService,
  ) {}

  async pingPostgres(): Promise<ProbeResult> {
    const probe = async (): Promise<ProbeResult> => {
      try {
        await sql`SELECT 1`.execute(this.db);
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    };

    return Promise.race([probe(), timeout(1000)]);
  }

  async pingRedis(): Promise<ProbeResult> {
    const probe = async (): Promise<ProbeResult> => {
      try {
        await this.redis.ping();
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    };

    return Promise.race([probe(), timeout(1000)]);
  }

  async pingNats(): Promise<ProbeResult> {
    const probe = async (): Promise<ProbeResult> => {
      try {
        const jsm = await this.nats.jetstreamManager();
        await jsm.streams.info('SCOREBOARD');
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    };

    return Promise.race([probe(), timeout(1000)]);
  }

  get leaderboardReady(): boolean {
    return this.readiness.leaderboardReady;
  }
}
