import {
  Body,
  Controller,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Counter } from 'prom-client';

import {
  IncrementScoreHandler,
  IncrementScoreResult,
  USER_SCORE_REPOSITORY,
} from '../../../application/commands';
import { IncrementScoreCommand } from '../../../application/commands/increment-score.command';
import { IdempotencyViolationError } from '../../../domain/errors/idempotency-violation.error';
import type { UserScoreRepository } from '../../../domain/ports/user-score.repository';
import { ActionId } from '../../../domain/value-objects/action-id';
import { ScoreDelta } from '../../../domain/value-objects/score-delta';
import { UserId } from '../../../domain/value-objects/user-id';
import { ActionTokenGuard } from '../../../infrastructure/auth/action-token.guard';
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
import { RateLimitGuard } from '../../../infrastructure/rate-limit/rate-limit.guard';
import { METRIC_SCORE_INCREMENT_TOTAL } from '../../../../shared/metrics';
import { IncrementScoreSchema } from '../dto/increment-score.dto';

@Controller('v1')
export class ScoreboardController {
  constructor(
    private readonly handler: IncrementScoreHandler,
    @Inject(USER_SCORE_REPOSITORY)
    private readonly repository: UserScoreRepository,
    @Inject(METRIC_SCORE_INCREMENT_TOTAL)
    private readonly scoreIncrementTotal: Counter<string>,
  ) {}

  // Guard order MUST be exactly [JwtGuard, ActionTokenGuard, RateLimitGuard] — spec and design.md §Decision 1
  @Post('scores:increment')
  @HttpCode(200)
  @UseGuards(JwtGuard, ActionTokenGuard, RateLimitGuard)
  async incrementScore(
    @Req() req: Record<string, unknown>,
    @Body() rawBody: unknown,
  ): Promise<IncrementScoreResult> {
    // ZodError propagates to the global HttpExceptionFilter → 400 INVALID_ARGUMENT
    const body = IncrementScoreSchema.parse(rawBody);

    // JwtGuard sets userId on the request
    const userId = (req as unknown as { userId: string }).userId; // JwtGuard sets this

    const cmd = new IncrementScoreCommand({
      userId: UserId.of(userId),
      actionId: ActionId.of(body.actionId),
      delta: ScoreDelta.of(body.delta),
      occurredAt: new Date(),
    });

    try {
      return await this.handler.execute(cmd);
    } catch (err) {
      if (err instanceof IdempotencyViolationError) {
        // Layer-2 idempotency replay (design.md Decision 4):
        // The Postgres unique constraint caught a duplicate — read the prior outcome and return it.
        const prior = await this.repository.findScoreEventByActionId(
          ActionId.of(body.actionId),
        );

        if (prior) {
          this.scoreIncrementTotal.inc({ result: 'idempotent' });
          return {
            userId: prior.userId,
            newScore: prior.totalScoreAfter,
            rank: null,
            topChanged: null,
          };
        }

        // Edge case: Postgres row is gone (DB wiped between original credit and replay).
        // Document: acceptable gap for MVP — step-05 outbox will harden this.
        // Fall through to a 500 rather than silently returning wrong data.
        throw new InternalServerErrorException({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Prior credit record not found for idempotent replay',
            requestId: null,
            hint: null,
          },
        });
      }

      // All other errors propagate to the global HttpExceptionFilter.
      throw err;
    }
  }
}
