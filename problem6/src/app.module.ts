import { Module } from '@nestjs/common';

import { ConfigModule } from './config';
import { DatabaseModule } from './database';
import { ScoreboardModule } from './scoreboard/scoreboard.module';

@Module({
  imports: [ConfigModule, DatabaseModule, ScoreboardModule],
})
export class AppModule {}
