import { Injectable } from '@nestjs/common';
import * as jose from 'jose';

import { ConfigService } from '../../../config';

import { ActionTokenClaims } from './action-token.types';
import { InvalidActionTokenError } from './errors';

@Injectable()
export class HmacActionTokenVerifier {
  private readonly secretKey: Uint8Array;

  constructor(config: ConfigService) {
    this.secretKey = new TextEncoder().encode(config.get('ACTION_TOKEN_SECRET'));
  }

  async verify(
    token: string,
    expectedSub: string,
    body: { actionId: string; delta: number },
  ): Promise<ActionTokenClaims> {
    try {
      const { payload } = await jose.jwtVerify(token, this.secretKey, {
        algorithms: ['HS256'],
      });

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
        sub: payload.sub as string,
        aid: payload['aid'] as string,
        atp: payload['atp'] as string,
        mxd: payload['mxd'] as number,
        iat: payload.iat as number,
        exp: payload.exp as number,
      };
    } catch (err) {
      if (err instanceof InvalidActionTokenError) throw err;
      throw new InvalidActionTokenError('invalid action token', err);
    }
  }
}
