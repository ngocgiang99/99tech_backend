import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ZodError } from 'zod';

import { ConfigService } from '../../../../config';
import { HmacActionTokenIssuer } from '../../../infrastructure/auth/hmac-action-token.issuer';
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
import { IssueActionTokenSchema } from '../dto/issue-action-token.dto';

// Action-type → max-delta map (v1 hardcoded; will move to config in a future change)
const ACTION_TYPE_MAX_DELTA: Record<string, number> = {
  'level-complete': 100,
  'boss-defeat': 500,
  'achievement-unlock': 1000,
};

@Controller('v1')
@UseGuards(JwtGuard)
export class ActionsController {
  constructor(
    private readonly issuer: HmacActionTokenIssuer,
    @Inject('Redis') private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  @Post('actions:issue-token')
  @HttpCode(200)
  async issueActionToken(
    @Req() req: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<{
    actionId: string;
    actionToken: string;
    expiresAt: string;
    maxDelta: number;
  }> {
    let dto: ReturnType<typeof IssueActionTokenSchema.parse>;
    try {
      dto = IssueActionTokenSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.format());
      }
      throw err;
    }

    // JwtGuard sets userId on the request; cast is safe — JwtGuard runs first via @UseGuards
    const userId = (req as unknown as { userId: string }).userId;

    const mxd = ACTION_TYPE_MAX_DELTA[dto.actionType];

    const result = await this.issuer.issue({
      sub: userId,
      atp: dto.actionType,
      mxd,
    });

    const ttl = this.config.get('ACTION_TOKEN_TTL_SECONDS') as number;
    await this.redis.set(
      'action:issued:' + result.actionId,
      '1',
      'EX',
      ttl,
      'NX',
    );

    // NEVER log result.actionToken — only actionId is safe to reference in logs
    return {
      actionId: result.actionId,
      actionToken: result.actionToken,
      expiresAt: result.expiresAt.toISOString(),
      maxDelta: result.maxDelta,
    };
  }
}
