import { Module } from '@nestjs/common';

import {
  IncrementScoreHandler,
  USER_SCORE_REPOSITORY,
} from './application/commands';
import { JwtGuard } from './infrastructure/auth/jwt.guard';
import { HmacActionTokenIssuer } from './infrastructure/auth/hmac-action-token.issuer';
import { HmacActionTokenVerifier } from './infrastructure/auth/hmac-action-token.verifier';
import { ActionTokenGuard } from './infrastructure/auth/action-token.guard';
import { OutboxPublisherService } from './infrastructure/outbox/outbox.publisher.service';
import { KyselyUserScoreRepository } from './infrastructure/persistence/kysely';
import { RedisLeaderboardCache } from './infrastructure/persistence/redis/leaderboard-cache.impl';
import { LeaderboardRebuilder } from './infrastructure/persistence/redis/leaderboard-rebuilder';
import { LeaderboardRebuildBootstrap } from './infrastructure/persistence/redis/leaderboard-rebuilder.bootstrap';
import { RedisTokenBucket } from './infrastructure/rate-limit/redis-token-bucket';
import { RateLimitGuard } from './infrastructure/rate-limit/rate-limit.guard';
import { ActionsController } from './interface/http/controllers/actions.controller';
import { LeaderboardController } from './interface/http/controllers/leaderboard.controller';
import { LeaderboardStreamController } from './interface/http/controllers/leaderboard-stream.controller';
import { ScoreboardController } from './interface/http/controllers/scoreboard.controller';
import { HealthModule } from './interface/health';

// RedisModule is @Global() and already imported in AppModule — do NOT import it here.
// NatsModule is @Global() and already imported in AppModule — do NOT import it here.

@Module({
  imports: [HealthModule],
  controllers: [
    ActionsController,
    ScoreboardController,
    LeaderboardController,
    LeaderboardStreamController,
  ],
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
    // Outbox publisher (depends on LeaderboardCache, so must live in this module's scope)
    OutboxPublisherService,
  ],
  exports: [IncrementScoreHandler],
})
export class ScoreboardModule {}
