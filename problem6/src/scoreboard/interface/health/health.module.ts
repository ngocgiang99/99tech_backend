import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// DatabaseModule, RedisModule, NatsModule, ReadinessModule, MetricsModule are all @Global()
// and imported in AppModule — no need to re-import here.
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
