import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { GetLeaderboardTopHandler } from '../../../application/queries';
import type { TopEntry } from '../../../domain/ports/user-score.repository';
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
import { ValidationError } from '../../../shared/errors';
import { LeaderboardTopQuerySchema } from '../dto/leaderboard.dto';

@Controller('v1/leaderboard')
@UseGuards(JwtGuard)
export class LeaderboardController {
  constructor(private readonly handler: GetLeaderboardTopHandler) {}

  @Get('top')
  async getTop(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ entries: TopEntry[]; generatedAt: string }> {
    const result = LeaderboardTopQuerySchema.safeParse(query);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((i) => i.message).join('; '),
        result.error.issues,
      );
    }
    const parsed = result.data;

    const outcome = await this.handler.execute(parsed.limit);
    res.header('X-Cache-Status', outcome.source);
    return { entries: outcome.entries, generatedAt: new Date().toISOString() };
  }
}
