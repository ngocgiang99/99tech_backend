import type { NestFastifyApplication } from '@nestjs/platform-fastify';

// Augment the Fastify Request type so TypeScript knows about our custom property.
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

/**
 * Registers a Fastify onRequest hook that:
 *  1. Honours a trusted inbound X-Request-Id header (if it matches the safe pattern).
 *  2. Falls back to a fresh ULID.
 *  3. Echoes the final ID back in the X-Request-Id response header.
 *  4. Stores the ID on request.requestId for downstream NestJS code.
 *
 * NOTE: nestjs-pino's genReqId option (wired in pino-logger.factory.ts) already
 * handles steps 1-2 and assigns req.id before the first log line.  This hook's
 * primary job is to expose request.requestId as a plain property so controllers
 * and filters can read it without going through pino internals.
 */
export function registerRequestIdHook(app: NestFastifyApplication): void {
  // Access the underlying Fastify instance.
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (request, reply, done) => {
    // req.id is already set by pino-http's genReqId before this hook fires
    // because nestjs-pino registers its middleware/plugin during app.init().
    // However, to be safe we assign requestId from the header or req.id.
    const existing = request.id as string | undefined;
    request.requestId =
      existing ?? String(request.headers['x-request-id'] ?? '');
    // Ensure the response header is present even if pino-http hasn't set it yet.
    if (!reply.hasHeader('X-Request-Id')) {
      reply.header('X-Request-Id', request.requestId);
    }
    done();
  });
}
