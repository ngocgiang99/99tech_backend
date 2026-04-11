import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
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
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);
  private quitCompleted = false;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.quitCompleted) {
      return;
    }
    this.quitCompleted = true;
    try {
      // quit() — drains pending commands, then closes. Intentionally NOT
      // disconnect(), which drops pending commands on the floor.
      await this.redis.quit();
      this.logger.log({ signal }, 'redis client quit');
    } catch (e) {
      this.logger.warn({ err: e, signal }, 'redis quit failed on shutdown');
    }
  }
}
