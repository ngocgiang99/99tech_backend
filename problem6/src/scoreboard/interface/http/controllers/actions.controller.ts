import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import {
  ACTION_TOKEN_ISSUER,
  type ActionTokenIssuer,
} from '../../../domain/ports/action-token-issuer.port';
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedUserId,
} from '../authenticated-request';
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
    @Inject(ACTION_TOKEN_ISSUER) private readonly issuer: ActionTokenIssuer,
  ) {}

  @Post('actions:issue-token')
  @HttpCode(200)
  async issueActionToken(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{
    actionId: string;
    actionToken: string;
    expiresAt: string;
    maxDelta: number;
  }> {
    // ZodError propagates to the global HttpExceptionFilter → 400 INVALID_ARGUMENT
    const dto = IssueActionTokenSchema.parse(body);

    const userId = getAuthenticatedUserId(req);

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
