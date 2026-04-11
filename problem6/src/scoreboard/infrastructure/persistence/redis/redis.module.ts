import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ConfigService } from '../../../../config';

import { buildRedisClient } from './redis.client';

export const REDIS = 'Redis';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (config: ConfigService): Redis => buildRedisClient(config),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
