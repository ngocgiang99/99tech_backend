import { initTracing } from './shared/tracing';

import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { ConfigService } from './config';
import { registerRequestIdHook, resolveRequestId } from './shared/logger';
import { MetricsInterceptor, processStartTimeSeconds } from './shared/metrics';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
  await initTracing();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      genReqId: (req: IncomingMessage | Http2ServerRequest) =>
        resolveRequestId(req.headers['x-request-id']),
    }),
    { bufferLogs: true },
  );

  // Route all NestJS framework logs through Pino.
  app.useLogger(app.get(Logger));

  // Fastify onRequest hook: expose request.requestId on each request object.
  registerRequestIdHook(app);

  await app.register(helmet);

  // Global exception filter is registered via APP_FILTER in AppModule so that
  // NestJS constructs it through DI and can inject the errors_total counter.

  // Global metrics interceptor: records HTTP request count and duration for every request.
  app.useGlobalInterceptors(app.get(MetricsInterceptor));

  // Enable NestJS lifecycle shutdown hooks (OnApplicationShutdown) so each
  // stateful adapter can release its external resources on SIGTERM/SIGINT.
  // See openspec/changes/add-runtime-resilience-utilities/design.md Decision 6.
  app.enableShutdownHooks();

  // Boot-time metric: set process start time once before listening.
  processStartTimeSeconds.set(Date.now() / 1000);

  const config = app.get(ConfigService);
  const port = config.get('PORT');
  await app.listen({ host: '0.0.0.0', port });
}

// Shutdown-timeout sentinel (Decision 7). NestJS's enableShutdownHooks() runs
// each adapter's onApplicationShutdown in parallel with this timer. The timer
// fires only if teardown exceeds SHUTDOWN_TIMEOUT_MS, and it's .unref()'d so
// a clean drain does not keep the event loop alive.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    const forceExitTimer = setTimeout(() => {
      console.warn(
        `[shutdown] ${signal}: exceeded ${SHUTDOWN_TIMEOUT_MS}ms timeout — forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref?.();
  });
}

void bootstrap();
