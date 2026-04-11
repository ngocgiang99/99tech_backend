import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import {
  IncrementScoreHandler,
  type IncrementScoreResult,
} from '../../../application/commands';
import { IncrementScoreCommand } from '../../../application/commands/increment-score.command';
import { ActionId } from '../../../domain/value-objects/action-id';
import { ScoreDelta } from '../../../domain/value-objects/score-delta';
import { UserId } from '../../../domain/value-objects/user-id';
import {
  type AuthenticatedRequest,
  getAuthenticatedUserId,
} from '../authenticated-request';
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { ActionTokenGuard } from '../../../infrastructure/auth/action-token.guard';
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { RateLimitGuard } from '../../../infrastructure/rate-limit/rate-limit.guard';
import { IncrementScoreSchema } from '../dto/increment-score.dto';

type IncrementScoreResponse = Omit<
  Extract<IncrementScoreResult, { kind: 'committed' }>,
  'kind'
>;

@Controller('v1')
export class ScoreboardController {
  constructor(private readonly handler: IncrementScoreHandler) {}

  // Guard order MUST be exactly [JwtGuard, ActionTokenGuard, RateLimitGuard] — spec and design.md §Decision 1
  @Post('scores:increment')
  @HttpCode(200)
  @UseGuards(JwtGuard, ActionTokenGuard, RateLimitGuard)
  async incrementScore(
    @Req() req: AuthenticatedRequest,
    @Body() rawBody: unknown,
  ): Promise<IncrementScoreResponse> {
    // ZodError propagates to the global HttpExceptionFilter → 400 INVALID_ARGUMENT
    const body = IncrementScoreSchema.parse(rawBody);

    const userId = getAuthenticatedUserId(req);

    const cmd = new IncrementScoreCommand({
      userId: UserId.of(userId),
      actionId: ActionId.of(body.actionId),
      delta: ScoreDelta.of(body.delta),
      occurredAt: new Date(),
    });

    const { kind: _kind, ...rest } = await this.handler.execute(cmd);
    void _kind;
    return rest;
  }
}
