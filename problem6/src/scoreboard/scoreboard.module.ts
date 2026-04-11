import { Module } from '@nestjs/common';

import {
  IncrementScoreHandler,
  USER_SCORE_REPOSITORY,
} from './application/commands';
import { JwtGuard } from './infrastructure/auth/jwt.guard';
import { HmacActionTokenIssuer } from './infrastructure/auth/hmac-action-token.issuer';
import { HmacActionTokenVerifier } from './infrastructure/auth/hmac-action-token.verifier';
import { ActionTokenGuard } from './infrastructure/auth/action-token.guard';
import { KyselyUserScoreRepository } from './infrastructure/persistence/kysely';
import { RedisLeaderboardCache } from './infrastructure/persistence/redis/leaderboard-cache.impl';
import { LeaderboardRebuilder } from './infrastructure/persistence/redis/leaderboard-rebuilder';
import { LeaderboardRebuildBootstrap } from './infrastructure/persistence/redis/leaderboard-rebuilder.bootstrap';
import { RedisTokenBucket } from './infrastructure/rate-limit/redis-token-bucket';
import { RateLimitGuard } from './infrastructure/rate-limit/rate-limit.guard';
import { ActionsController } from './interface/http/controllers/actions.controller';
import { LeaderboardController } from './interface/http/controllers/leaderboard.controller';
import { ScoreboardController } from './interface/http/controllers/scoreboard.controller';

// RedisModule is @Global() and already imported in AppModule — do NOT import it here.

@Module({
  controllers: [ActionsController, ScoreboardController, LeaderboardController],
  providers: [
    // Repository
    {
      provide: USER_SCORE_REPOSITORY,
      useClass: KyselyUserScoreRepository,
    },
    // Application layer
    IncrementScoreHandler,
    // Auth
    JwtGuard,
    HmacActionTokenIssuer,
    HmacActionTokenVerifier,
    ActionTokenGuard,
    // Rate limiting
    RedisTokenBucket,
    RateLimitGuard,
    // Leaderboard cache
    { provide: 'LeaderboardCache', useClass: RedisLeaderboardCache },
    LeaderboardRebuilder,
    LeaderboardRebuildBootstrap,
  ],
  exports: [IncrementScoreHandler],
})
export class ScoreboardModule {}
