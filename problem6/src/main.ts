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

  // Boot-time metric: set process start time once before listening.
  processStartTimeSeconds.set(Date.now() / 1000);

  const config = app.get(ConfigService);
  const port = config.get('PORT');
  await app.listen({ host: '0.0.0.0', port });
}

void bootstrap();
