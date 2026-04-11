import { Controller, Get, Inject, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { DATABASE } from '../../../../database';
import type { Database } from '../../../../database';
import type { LeaderboardCache } from '../../../domain/ports/leaderboard-cache';
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
import { ValidationError } from '../../../shared/errors';
import { LeaderboardTopQuerySchema } from '../dto/leaderboard.dto';

@Controller('v1/leaderboard')
@UseGuards(JwtGuard)
export class LeaderboardController {
  constructor(
    @Inject('LeaderboardCache') private readonly cache: LeaderboardCache,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get('top')
  async getTop(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ entries: unknown[]; generatedAt: string }> {
    const result = LeaderboardTopQuerySchema.safeParse(query);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((i) => i.message).join('; '),
        result.error.issues,
      );
    }
    const parsed = result.data;

    const entries = await this.cache.getTop(parsed.limit);
    if (entries.length > 0) {
      return { entries, generatedAt: new Date().toISOString() };
    }

    // Cache miss — fall back to direct Postgres query
    const rows = await this.db
      .selectFrom('user_scores')
      .select(['user_id', 'total_score', 'updated_at'])
      .orderBy('total_score', 'desc')
      .orderBy('updated_at', 'asc')
      .limit(parsed.limit)
      .execute();

    const fallbackEntries = rows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      score: Number(row.total_score),
      updatedAt: new Date(row.updated_at),
    }));

    res.header('X-Cache-Status', 'miss-fallback');
    return { entries: fallbackEntries, generatedAt: new Date().toISOString() };
  }
}
