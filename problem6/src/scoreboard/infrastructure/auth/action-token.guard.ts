import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ConfigService } from '../../../config';

import { ActionTokenClaims } from './action-token.types';
import { InvalidActionTokenError } from './errors';
import { HmacActionTokenVerifier } from './hmac-action-token.verifier';

@Injectable()
export class ActionTokenGuard implements CanActivate {
  constructor(
    private readonly verifier: HmacActionTokenVerifier,
    @Inject('Redis') private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();

    const userId = request['userId'] as string | undefined;
    if (userId === undefined) {
      throw new Error('JwtGuard must run before ActionTokenGuard — userId is not set on the request');
    }

    const headers = request['headers'] as Record<string, string>;
    const actionToken = headers['action-token'] ?? headers['Action-Token'];

    const body = request['body'] as Record<string, unknown>;
    const actionId = body['actionId'] as string;
    const delta = body['delta'] as number;

    let claims: ActionTokenClaims;
    try {
      claims = await this.verifier.verify(actionToken, userId, { actionId, delta });
    } catch (err) {
      if (err instanceof InvalidActionTokenError) {
        throw new ForbiddenException('INVALID_ACTION_TOKEN');
      }
      throw new ForbiddenException('INVALID_ACTION_TOKEN');
    }

    const ttl = this.config.get('ACTION_TOKEN_TTL_SECONDS') as number;
    const result = await this.redis.set(
      'idempotency:action:' + actionId,
      '1',
      'EX',
      ttl,
      'NX',
    );

    if (result === null) {
      throw new ForbiddenException('ACTION_ALREADY_CONSUMED');
    }

    (request as Record<string, unknown>)['actionTokenClaims'] = claims;
    return true;
  }
}
