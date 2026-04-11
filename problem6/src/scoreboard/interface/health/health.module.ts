import { Module } from '@nestjs/common';

// eslint-disable-next-line boundaries/dependencies -- health module provisions the infra-layer HealthService for the HTTP adapter, see design.md Decision 6
import { HealthService } from '../../infrastructure/health/health.service';

import { HealthController } from './health.controller';

// DatabaseModule, RedisModule, NatsModule, ReadinessModule, MetricsModule are all @Global()
// and imported in AppModule — no need to re-import here.
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
