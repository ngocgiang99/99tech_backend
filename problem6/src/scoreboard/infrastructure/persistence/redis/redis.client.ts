import { Redis } from 'ioredis';

import { ConfigService } from '../../../../config';

export function buildRedisClient(config: ConfigService): Redis {
  return new Redis(config.get('REDIS_URL'));
}
