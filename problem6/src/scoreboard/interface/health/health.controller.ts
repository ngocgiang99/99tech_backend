import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Registry } from 'prom-client';

import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @Inject('PrometheusRegistry') private readonly registry: Registry,
  ) {}

  @Get('health')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() reply: FastifyReply): Promise<void> {
    const [postgres, redis, nats] = await Promise.all([
      this.health.pingPostgres(),
      this.health.pingRedis(),
      this.health.pingNats(),
    ]);

    const leaderboardOk = this.health.leaderboardReady;

    const allOk = postgres.ok && redis.ok && nats.ok && leaderboardOk;

    const checks: Record<string, string> = {
      postgres: postgres.ok ? 'up' : 'down',
      redis: redis.ok ? 'up' : 'down',
      nats: nats.ok ? 'up' : 'down',
      leaderboard: leaderboardOk ? 'ready' : 'rebuilding',
    };

    const statusCode = allOk ? 200 : 503;
    reply.status(statusCode).send({ checks });
  }

  @Get('metrics')
  async metrics(@Res() reply: FastifyReply): Promise<void> {
    const body = await this.registry.metrics();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    reply.raw.write(body);
    reply.raw.end();
  }
}
