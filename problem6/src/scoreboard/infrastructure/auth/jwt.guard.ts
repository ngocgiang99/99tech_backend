import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import * as jose from 'jose';
import { trace, SpanStatusCode } from '@opentelemetry/api';

import { ConfigService } from '../../../config';
import { UnauthenticatedError } from '../../shared/errors';

/**
 * Local contract: JwtGuard attaches `userId` to the Fastify request. The
 * `interface` layer re-exposes this as `AuthenticatedRequest` via
 * `src/scoreboard/interface/http/authenticated-request.ts`. Keeping the
 * attachment contract local here (rather than importing the interface type)
 * preserves the hexagonal layering — `infrastructure` never reaches up into
 * `interface`.
 */
type JwtAttachedRequest = FastifyRequest & { userId?: string };

// TODO: add INTERNAL_JWT_SECRET_PREV before production release — see archived change replace-jwks-with-internal-hs256 design.md Decision 1

const tracer = trace.getTracer('scoreboard');

@Injectable()
export class JwtGuard implements CanActivate {
  private readonly secret: Uint8Array;

  constructor(config: ConfigService) {
    this.secret = new TextEncoder().encode(config.get('INTERNAL_JWT_SECRET'));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    try {
      const request = ctx.switchToHttp().getRequest<JwtAttachedRequest>();
      const headers = request.headers;
      const authorization = headers.authorization;

      if (!authorization) {
        throw new UnauthenticatedError('Unauthorized');
      }

      const parts = authorization.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthenticatedError('Unauthorized');
      }

      const token = parts[1];

      // Pre-parse: base64url-decode the header segment and reject alg=none
      // before any signature verification
      const headerSegment = token.split('.')[0];
      if (headerSegment) {
        try {
          // base64url → base64 → JSON
          const padded = headerSegment.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(padded, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded) as Record<string, unknown>;
          if (parsed['alg'] === 'none') {
            throw new UnauthenticatedError('Unauthorized');
          }
        } catch (parseErr) {
          if (parseErr instanceof UnauthenticatedError) throw parseErr;
          throw new UnauthenticatedError('Unauthorized');
        }
      }

      const payload = await tracer.startActiveSpan(
        'jwt.verify',
        async (span) => {
          try {
            const { payload: jwtPayload } = await jose.jwtVerify(
              token,
              this.secret,
              { algorithms: ['HS256'] },
            );
            return jwtPayload;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            throw e;
          } finally {
            span.end();
          }
        },
      );

      request.userId = payload.sub;
      return true;
    } catch (err) {
      if (err instanceof UnauthenticatedError) throw err;
      throw new UnauthenticatedError('Unauthorized');
    }
  }
}
