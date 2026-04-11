import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { ConfigService } from '../../../config';

import { RedisTokenBucket } from './redis-token-bucket';

// Global per-instance circuit breaker counter.
// Resets every second without blocking process exit.
let globalCount = 0;
const _resetInterval = setInterval(() => {
  globalCount = 0;
}, 1000).unref();

// Prevent unused-variable lint errors in environments that tree-shake
void _resetInterval;

const GLOBAL_LIMIT = 5000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly bucket: RedisTokenBucket,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    globalCount++;

    if (globalCount > GLOBAL_LIMIT) {
      throw new HttpException(
        { statusCode: 503, code: 'TEMPORARILY_UNAVAILABLE' },
        503,
      );
    }

    const http = ctx.switchToHttp();
    const request = http.getRequest<FastifyRequest & { userId?: string }>();
    const response = http.getResponse<FastifyReply>();

    const userId = request.userId;
    if (userId === undefined) {
      // JwtGuard must run before RateLimitGuard — this is a wiring bug
      throw new Error(
        'RateLimitGuard: request.userId is undefined — JwtGuard must run first',
      );
    }

    const refillPerSec = this.config.get('RATE_LIMIT_PER_SEC');
    const result = await this.bucket.consume(userId, 20, refillPerSec);

    if (!result.allowed) {
      const retryAfterSeconds = result.retryAfterMs !== undefined
        ? Math.ceil(result.retryAfterMs / 1000)
        : 1;
      void response.header('Retry-After', String(retryAfterSeconds));
      throw new HttpException(
        { statusCode: 429, code: 'RATE_LIMITED' },
        429,
      );
    }

    return true;
  }
}
