import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

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
  constructor(private readonly issuer: HmacActionTokenIssuer) {}

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
    // ZodError propagates to the global HttpExceptionFilter → 400 INVALID_ARGUMENT
    const dto = IssueActionTokenSchema.parse(body);

    // JwtGuard sets userId on the request; cast is safe — JwtGuard runs first via @UseGuards
    const userId = (req as unknown as { userId: string }).userId;

    const mxd = ACTION_TYPE_MAX_DELTA[dto.actionType];

    const result = await this.issuer.issue({
      sub: userId,
      atp: dto.actionType,
      mxd,
    });

    // NEVER log result.actionToken — only actionId is safe to reference in logs
    return {
      actionId: result.actionId,
      actionToken: result.actionToken,
      expiresAt: result.expiresAt.toISOString(),
      maxDelta: result.maxDelta,
    };
  }
}
