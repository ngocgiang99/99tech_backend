import { Module } from '@nestjs/common';

import { ScoreboardModule } from './scoreboard/scoreboard.module';

@Module({
  imports: [ScoreboardModule],
})
export class AppModule {}
