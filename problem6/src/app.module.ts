import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule, ConfigService } from './config';
import { DatabaseModule } from './database';
import { NatsModule } from './scoreboard/infrastructure/messaging/nats';
import { HealthModule } from './scoreboard/interface/health';
import { buildPinoLoggerOptions } from './shared/logger';
import { MetricsModule } from './shared/metrics';
import { ReadinessModule } from './shared/readiness';
import { RedisModule } from './scoreboard/infrastructure/persistence/redis';
import { ScoreboardModule } from './scoreboard/scoreboard.module';

@Module({
  imports: [
    ConfigModule,
    EventEmitterModule.forRoot(),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: buildPinoLoggerOptions(config),
      }),
    }),
    ReadinessModule,
    MetricsModule,
    DatabaseModule,
    RedisModule,
    NatsModule,
    HealthModule,
    ScoreboardModule,
  ],
})
export class AppModule {}
