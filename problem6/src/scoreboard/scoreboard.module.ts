import { Module } from '@nestjs/common';

import {
  IncrementScoreHandler,
  USER_SCORE_REPOSITORY,
} from './application/commands';
import { KyselyUserScoreRepository } from './infrastructure/persistence/kysely';

@Module({
  providers: [
    {
      provide: USER_SCORE_REPOSITORY,
      useClass: KyselyUserScoreRepository,
    },
    IncrementScoreHandler,
  ],
  exports: [IncrementScoreHandler],
})
export class ScoreboardModule {}
