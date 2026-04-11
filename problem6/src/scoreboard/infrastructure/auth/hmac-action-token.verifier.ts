import { Injectable } from '@nestjs/common';
import * as jose from 'jose';
import { trace, SpanStatusCode } from '@opentelemetry/api';

import { ConfigService } from '../../../config';

import { ActionTokenClaims } from './action-token.types';
import { InvalidActionTokenError } from './errors';

const tracer = trace.getTracer('scoreboard');

@Injectable()
export class HmacActionTokenVerifier {
  private readonly primaryKey: Uint8Array;
  private readonly prevKey: Uint8Array | null;

  constructor(config: ConfigService) {
    this.primaryKey = new TextEncoder().encode(
      config.get('ACTION_TOKEN_SECRET'),
    );
    const prev = config.get('ACTION_TOKEN_SECRET_PREV');
    this.prevKey = prev ? new TextEncoder().encode(prev) : null;
  }

  async verify(
    token: string,
    expectedSub: string,
    body: { actionId: string; delta: number },
  ): Promise<ActionTokenClaims> {
    return tracer.startActiveSpan('action-token.verify', async (span) => {
      try {
        let payload: jose.JWTPayload;
        try {
          ({ payload } = await jose.jwtVerify(token, this.primaryKey, {
            algorithms: ['HS256'],
          }));
        } catch (primaryErr) {
          if (
            primaryErr instanceof jose.errors.JWSSignatureVerificationFailed &&
            this.prevKey !== null
          ) {
            ({ payload } = await jose.jwtVerify(token, this.prevKey, {
              algorithms: ['HS256'],
            }));
          } else {
            throw primaryErr;
          }
        }

        if (payload.sub !== expectedSub) {
          throw new InvalidActionTokenError('sub mismatch');
        }
        if (payload['aid'] !== body.actionId) {
          throw new InvalidActionTokenError('aid mismatch');
        }
        if (typeof payload['mxd'] !== 'number' || payload['mxd'] < body.delta) {
          throw new InvalidActionTokenError('mxd too low or invalid');
        }

        return {
          sub: payload.sub,
          aid: payload['aid'],
          atp: payload['atp'] as string,
          mxd: payload['mxd'],
          iat: payload.iat as number,
          exp: payload.exp as number,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        if (err instanceof InvalidActionTokenError) throw err;
        throw new InvalidActionTokenError('invalid action token', err);
      } finally {
        span.end();
      }
    });
  }
}
