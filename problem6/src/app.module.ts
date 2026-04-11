import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule, ConfigService } from './config';
import { DatabaseModule } from './database';
import { NatsModule } from './scoreboard/infrastructure/messaging/nats';
import { HealthModule } from './scoreboard/interface/health';
import { HttpExceptionFilter } from './scoreboard/interface/http/error-filter';
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
  providers: [
    // Global HTTP exception filter — bound via APP_FILTER so NestJS constructs
    // it through DI (needed for @Inject(METRIC_ERRORS_TOTAL)). MetricsModule is
    // @Global() so the token resolves without explicit imports.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
