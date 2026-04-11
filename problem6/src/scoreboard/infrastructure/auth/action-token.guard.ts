import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Counter } from 'prom-client';

import { ConfigService } from '../../../config';
import { METRIC_ACTION_TOKEN_VERIFY_TOTAL } from '../../../shared/metrics';
import { ForbiddenError } from '../../shared/errors';

import { ActionTokenClaims } from './action-token.types';
import { InvalidActionTokenError } from './errors';
import { HmacActionTokenVerifier } from './hmac-action-token.verifier';

const tracer = trace.getTracer('scoreboard');

@Injectable()
export class ActionTokenGuard implements CanActivate {
  constructor(
    private readonly verifier: HmacActionTokenVerifier,
    @Inject('Redis') private readonly redis: Redis,
    private readonly config: ConfigService,
    @Inject(METRIC_ACTION_TOKEN_VERIFY_TOTAL)
    private readonly actionTokenVerifyTotal: Counter<string>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();

    const userId = request['userId'] as string | undefined;
    if (userId === undefined) {
      throw new Error(
        'JwtGuard must run before ActionTokenGuard — userId is not set on the request',
      );
    }

    const headers = request['headers'] as Record<string, string>;
    const actionToken = headers['action-token'] ?? headers['Action-Token'];

    const body = request['body'] as Record<string, unknown>;
    const actionId = body['actionId'] as string;
    const delta = body['delta'] as number;

    let claims: ActionTokenClaims;
    try {
      claims = await this.verifier.verify(actionToken, userId, {
        actionId,
        delta,
      });
    } catch (err) {
      if (err instanceof InvalidActionTokenError) {
        this.actionTokenVerifyTotal.inc({ outcome: 'invalid' });
        throw new ForbiddenError('INVALID_ACTION_TOKEN');
      }
      this.actionTokenVerifyTotal.inc({ outcome: 'invalid' });
      throw new ForbiddenError('INVALID_ACTION_TOKEN');
    }

    const ttl = this.config.get('ACTION_TOKEN_TTL_SECONDS');
    const result = await tracer.startActiveSpan(
      'idempotency.check',
      async (span) => {
        try {
          return await this.redis.set(
            'idempotency:action:' + actionId,
            '1',
            'EX',
            ttl,
            'NX',
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
          throw e;
        } finally {
          span.end();
        }
      },
    );

    if (result === null) {
      this.actionTokenVerifyTotal.inc({ outcome: 'consumed' });
      throw new ForbiddenError('ACTION_ALREADY_CONSUMED');
    }

    this.actionTokenVerifyTotal.inc({ outcome: 'ok' });
    request['actionTokenClaims'] = claims;
    return true;
  }
}
