import { Injectable } from '@nestjs/common';
import * as jose from 'jose';

import { ConfigService } from '../../../config';
import type {
  ActionTokenIssuer,
  IssuedActionToken,
} from '../../domain/ports/action-token-issuer.port';

@Injectable()
export class HmacActionTokenIssuer implements ActionTokenIssuer {
  private readonly secretKey: Uint8Array;

  constructor(private readonly config: ConfigService) {
    this.secretKey = new TextEncoder().encode(
      config.get('ACTION_TOKEN_SECRET'),
    );
  }

  async issue(input: {
    sub: string;
    atp: string;
    mxd: number;
  }): Promise<IssuedActionToken> {
    const actionId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const ttl = this.config.get('ACTION_TOKEN_TTL_SECONDS');
    const exp = now + ttl;

    const actionToken = await new jose.SignJWT({
      aid: actionId,
      atp: input.atp,
      mxd: input.mxd,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.sub)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.secretKey);

    return {
      actionId,
      actionToken,
      expiresAt: new Date(exp * 1000),
      maxDelta: input.mxd,
    };
  }
}
