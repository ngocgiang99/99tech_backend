import { Module } from '@nestjs/common';

import { ConfigModule } from './config';
import { DatabaseModule } from './database';
import { RedisModule } from './scoreboard/infrastructure/persistence/redis';
import { ScoreboardModule } from './scoreboard/scoreboard.module';

@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, ScoreboardModule],
})
export class AppModule {}
