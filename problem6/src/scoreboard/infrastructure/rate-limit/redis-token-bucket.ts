import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';

@Injectable()
export class RedisTokenBucket implements OnModuleInit {
  private sha!: string;
  private readonly luaSource: string;

  constructor(@Inject('Redis') private readonly redis: Redis) {
    this.luaSource = readFileSync(
      join(__dirname, 'lua', 'token-bucket.lua'),
      'utf8',
    );
  }

  async onModuleInit(): Promise<void> {
    this.sha = await this.redis.script('LOAD', this.luaSource) as string;
  }

  async consume(
    userId: string,
    capacity = 20,
    refillPerSec = 10,
  ): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const key = 'rate:user:' + userId;
    const result = await this.evalsha(key, capacity, refillPerSec, Date.now());
    return this.parseResult(result as [number, number]);
  }

  private async evalsha(
    key: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number,
  ): Promise<unknown> {
    try {
      return await this.redis.evalsha(
        this.sha,
        1,
        key,
        capacity,
        refillPerSec,
        nowMs,
      );
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes('NOSCRIPT')
      ) {
        // Script was flushed from Redis — reload and retry once
        this.sha = await this.redis.script('LOAD', this.luaSource) as string;
        return await this.redis.evalsha(
          this.sha,
          1,
          key,
          capacity,
          refillPerSec,
          nowMs,
        );
      }
      throw err;
    }
  }

  private parseResult(result: [number, number]): {
    allowed: boolean;
    retryAfterMs?: number;
  } {
    const [allowed, value] = result;
    if (allowed === 1) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: value };
  }
}
