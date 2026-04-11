import { Injectable } from '@nestjs/common';
import * as jose from 'jose';
import type { JWTPayload, RemoteJWKSetOptions } from 'jose';

import { ConfigService } from '../../../config';

import { InvalidJwtError } from './errors';

type JwksGetter = ReturnType<typeof jose.createRemoteJWKSet>;

@Injectable()
export class JwksCache {
  private jwks: JwksGetter | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Verify a JWT bearer token. Lazily initialises the JWKS getter on first call.
   *
   * Note: jose.createRemoteJWKSet handles its own in-memory cache with a 1-hour
   * TTL per key-ID. No manual cache management is needed here.
   */
  async verify(token: string): Promise<JWTPayload> {
    if (!this.jwks) {
      const options: RemoteJWKSetOptions = {};
      this.jwks = jose.createRemoteJWKSet(
        new URL(this.config.get('JWKS_URL')),
        options,
      );
    }

    try {
      const { payload } = await jose.jwtVerify(token, this.jwks, {
        issuer: this.config.get('JWT_ISSUER'),
        audience: this.config.get('JWT_AUDIENCE'),
        algorithms: ['RS256', 'ES256'],
      });
      return payload;
    } catch (err) {
      if (err instanceof jose.errors.JOSEError) {
        throw new InvalidJwtError(err.message, err);
      }
      throw err;
    }
  }
}
