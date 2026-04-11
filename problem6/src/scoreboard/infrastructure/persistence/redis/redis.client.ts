import { Redis } from 'ioredis';

import { ConfigService } from '../../../../config';

export function buildRedisClient(config: ConfigService): Redis {
  // maxRetriesPerRequest: 1 — GAP-03 fail-CLOSED. If a command can't complete
  // after one retry, surface as MaxRetriesPerRequestError so HttpExceptionFilter
  // can map it to 503 instead of letting the default 20-retry loop block the
  // request for ~15s before returning 500.
  //
  // enableOfflineQueue stays at its default (true) so that Lua script EVALSHA
  // registration in RedisTokenBucket.onModuleInit() can queue commands during
  // the initial TCP connect handshake.
  return new Redis(config.get('REDIS_URL'), {
    maxRetriesPerRequest: 1,
  });
}
