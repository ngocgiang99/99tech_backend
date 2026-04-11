import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { ConfigModule, ConfigService } from './config';
import { DatabaseModule } from './database';
import { buildPinoLoggerOptions } from './shared/logger';
import { MetricsModule } from './shared/metrics';
import { RedisModule } from './scoreboard/infrastructure/persistence/redis';
import { ScoreboardModule } from './scoreboard/scoreboard.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: buildPinoLoggerOptions(config),
      }),
    }),
    MetricsModule,
    DatabaseModule,
    RedisModule,
    ScoreboardModule,
  ],
})
export class AppModule {}
