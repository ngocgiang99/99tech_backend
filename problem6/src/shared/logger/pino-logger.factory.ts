import { ulid } from 'ulid';

import type { Params } from 'nestjs-pino';

import { ConfigService } from '../../config';

const REQUEST_ID_HEADER_RE = /^[A-Za-z0-9]{16,40}$/;

/**
 * Validates the inbound X-Request-Id header value.
 * If valid, returns it as-is.  Otherwise generates a fresh ULID.
 *
 * Exported so the Fastify onRequest hook can share the same logic.
 */
export function resolveRequestId(
  inbound: string | string[] | undefined,
): string {
  const raw = Array.isArray(inbound) ? inbound[0] : inbound;
  if (raw && REQUEST_ID_HEADER_RE.test(raw)) {
    return raw;
  }

  return ulid();
}

/**
 * Builds the pinoHttp options block for nestjs-pino's LoggerModule.forRootAsync.
 *
 * - JSON output in production, pino-pretty in development.
 * - Sensitive headers and tokens are redacted before serialization.
 * - genReqId assigns the request ID from the inbound header or a fresh ULID,
 *   and writes the X-Request-Id response header at the same time so every log
 *   line already carries the ID.
 */
export function buildPinoLoggerOptions(
  config: ConfigService,
): NonNullable<Params['pinoHttp']> {
  const level = config.get('LOG_LEVEL');
  const isDev = config.get('NODE_ENV') === 'development';

  // pino-http's GenReqId is typed for Node http IncomingMessage/ServerResponse,
  // but under Fastify the reply object has a .header() method.  We use unknown
  // with explicit type narrowing for the genReqId callback; runtime behaviour is correct.
  type ReqLike = { headers?: Record<string, string | string[] | undefined> };
  type ReplyLike = {
    header?: (name: string, value: string) => void;
    setHeader?: (name: string, value: string) => void;
  };

  const genReqId = (req: ReqLike, reply: ReplyLike): string => {
    const id = resolveRequestId(req.headers?.['x-request-id']);
    // Fastify reply has .header(); fallback to setHeader for plain Node ServerResponse.
    if (typeof reply.header === 'function') {
      reply.header('X-Request-Id', id);
    } else if (typeof reply.setHeader === 'function') {
      reply.setHeader('X-Request-Id', id);
    }
    return id;
  };

  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["action-token"]',
        '*.actionToken',
        '*.ACTION_TOKEN_SECRET',
        '*.ACTION_TOKEN_SECRET_PREV',
        '*.INTERNAL_JWT_SECRET',
      ],
      remove: true,
    },
    // genReqId is invoked by pino-http before the first log line, so every
    // subsequent log in the request lifecycle automatically carries the ID.

    genReqId: genReqId as NonNullable<Params['pinoHttp']> extends {
      genReqId?: infer G;
    }
      ? G
      : never,
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: false },
        }
      : undefined,
  };
}
