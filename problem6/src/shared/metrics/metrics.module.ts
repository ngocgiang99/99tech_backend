import { Global, Module } from '@nestjs/common';

import { MetricsInterceptor } from './metrics.interceptor';
import { registry } from './registry';
import {
  actionTokenVerifyTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  METRIC_ACTION_TOKEN_VERIFY_TOTAL,
  METRIC_HTTP_REQUEST_DURATION_SECONDS,
  METRIC_HTTP_REQUESTS_TOTAL,
  METRIC_PROCESS_START_TIME_SECONDS,
  METRIC_RATE_LIMIT_HITS_TOTAL,
  METRIC_SCORE_INCREMENT_TOTAL,
  processStartTimeSeconds,
  rateLimitHitsTotal,
  scoreIncrementTotal,
} from './write-path-metrics';

/**
 * MetricsModule — @Global() so all modules can inject metrics without importing MetricsModule.
 *
 * Each metric is provided under a string token (METRIC_* constants) so consumers
 * only inject the specific counter/histogram they need, keeping deps explicit.
 *
 * IMPORTANT: prom-client throws if the same metric name is registered twice.
 * MetricsModule MUST be imported exactly once (AppModule root). @Global() + NestJS DI
 * guarantees this — do not import MetricsModule in any child module.
 */
@Global()
@Module({
  providers: [
    MetricsInterceptor,
    {
      provide: 'PrometheusRegistry',
      useValue: registry,
    },
    {
      provide: METRIC_HTTP_REQUESTS_TOTAL,
      useValue: httpRequestsTotal,
    },
    {
      provide: METRIC_HTTP_REQUEST_DURATION_SECONDS,
      useValue: httpRequestDurationSeconds,
    },
    {
      provide: METRIC_SCORE_INCREMENT_TOTAL,
      useValue: scoreIncrementTotal,
    },
    {
      provide: METRIC_ACTION_TOKEN_VERIFY_TOTAL,
      useValue: actionTokenVerifyTotal,
    },
    {
      provide: METRIC_RATE_LIMIT_HITS_TOTAL,
      useValue: rateLimitHitsTotal,
    },
    {
      provide: METRIC_PROCESS_START_TIME_SECONDS,
      useValue: processStartTimeSeconds,
    },
  ],
  exports: [
    MetricsInterceptor,
    'PrometheusRegistry',
    METRIC_HTTP_REQUESTS_TOTAL,
    METRIC_HTTP_REQUEST_DURATION_SECONDS,
    METRIC_SCORE_INCREMENT_TOTAL,
    METRIC_ACTION_TOKEN_VERIFY_TOTAL,
    METRIC_RATE_LIMIT_HITS_TOTAL,
    METRIC_PROCESS_START_TIME_SECONDS,
  ],
})
export class MetricsModule {}
