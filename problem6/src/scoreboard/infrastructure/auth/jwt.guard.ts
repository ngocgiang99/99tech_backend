import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';

import { JwksCache } from './jwks-cache';

const tracer = trace.getTracer('scoreboard');

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly jwks: JwksCache) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    try {
      const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();
      const authHeader = request['headers'] as
        | Record<string, string>
        | undefined;
      const authorization =
        authHeader?.['authorization'] ?? authHeader?.['Authorization'];

      if (!authorization) {
        throw new UnauthorizedException('Unauthorized');
      }

      const parts = authorization.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthorizedException('Unauthorized');
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
            throw new UnauthorizedException('Unauthorized');
          }
        } catch (parseErr) {
          if (parseErr instanceof UnauthorizedException) throw parseErr;
          throw new UnauthorizedException('Unauthorized');
        }
      }

      const payload = await tracer.startActiveSpan(
        'jwt.verify',
        async (span) => {
          try {
            return await this.jwks.verify(token);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
            throw e;
          } finally {
            span.end();
          }
        },
      );

      request['userId'] = payload.sub;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Unauthorized');
    }
  }
}
