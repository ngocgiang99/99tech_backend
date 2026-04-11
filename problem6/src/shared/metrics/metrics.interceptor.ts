import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Counter, Histogram } from 'prom-client';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import {
  METRIC_HTTP_REQUEST_DURATION_SECONDS,
  METRIC_HTTP_REQUESTS_TOTAL,
} from './write-path-metrics';

/**
 * MetricsInterceptor — cross-cutting HTTP metrics recorder.
 *
 * Records scoreboard_http_requests_total{method, route, status} and
 * scoreboard_http_request_duration_seconds{method, route} for every
 * completed request.
 *
 * Registered globally in main.ts via app.useGlobalInterceptors(...) so
 * no controller needs to be modified for basic HTTP metrics.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @Inject(METRIC_HTTP_REQUESTS_TOTAL)
    private readonly requestsTotal: Counter<string>,
    @Inject(METRIC_HTTP_REQUEST_DURATION_SECONDS)
    private readonly requestDuration: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method?: string;
      routerPath?: string;
      url?: string;
    }>();

    const method = (request.method ?? 'UNKNOWN').toUpperCase();
    // routerPath is the Fastify matched route pattern (e.g. /v1/scores:increment), not the raw URL
    const route = request.routerPath ?? request.url ?? 'unknown';

    const startMs = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const reply = http.getResponse<{ statusCode?: number }>();
          const status = String(reply.statusCode ?? 200);
          const durationSeconds = (Date.now() - startMs) / 1000;

          this.requestsTotal.inc({ method, route, status });
          this.requestDuration.observe({ method, route }, durationSeconds);
        },
        error: (err: unknown) => {
          // On error the status may not be set on the reply yet — extract from the exception if possible
          const statusCode =
            err != null &&
            typeof err === 'object' &&
            'status' in err &&
            typeof (err as Record<string, unknown>)['status'] === 'number'
              ? ((err as Record<string, unknown>)['status'] as number)
              : 500;
          const status = String(statusCode);
          const durationSeconds = (Date.now() - startMs) / 1000;

          this.requestsTotal.inc({ method, route, status });
          this.requestDuration.observe({ method, route }, durationSeconds);
        },
      }),
    );
  }
}
