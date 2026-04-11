import * as crypto from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Inject,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Counter } from 'prom-client';

import { METRIC_ERRORS_TOTAL } from '../../../shared/metrics/write-path-metrics';
import {
  buildErrorMetadata,
  toPublicResponse,
  wrapUnknown,
} from '../../shared/errors';

/**
 * Global HTTP exception filter.
 *
 * Every thrown value reaches this filter and is routed through a single
 * pipeline — no branching, no instanceof checks. The pipeline:
 *
 *   1. headersSent idempotency guard
 *   2. wrapUnknown()      → DomainError
 *   3. crypto.randomUUID  → errorId (used only if status >= 500)
 *   4. buildErrorMetadata → structured log payload
 *   5. logger.{warn|error}(metadata, 'Request error')
 *   6. errorsTotal.inc({code, status})
 *   7. toPublicResponse   → public envelope (errorId hidden for <500)
 *   8. reply.status(...).send(body)
 *
 * Classification logic lives in `wrapUnknown`. Envelope shape lives in
 * `toPublicResponse`. Metadata extraction lives in `buildErrorMetadata`.
 * This filter is pure orchestration.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(
    @Inject(METRIC_ERRORS_TOTAL)
    private readonly errorsTotal: Counter<'code' | 'status'>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest & { requestId?: string }>();
    const reply = ctx.getResponse<FastifyReply>();

    if (reply.raw.headersSent) {
      return;
    }

    const appErr = wrapUnknown(exception);
    const errorId = crypto.randomUUID();
    const status = appErr.getStatus();
    const metadata = buildErrorMetadata(appErr, request, errorId);

    if (status >= 500) {
      this.logger.error(metadata, 'Request error');
    } else {
      this.logger.warn(metadata, 'Request error');
    }

    this.errorsTotal.inc({ code: appErr.code, status: String(status) });

    const requestId = request.requestId ?? null;
    const { status: envelopeStatus, body } = toPublicResponse(
      appErr,
      requestId,
      status >= 500 ? errorId : null,
    );

    void reply.status(envelopeStatus).send(body);
  }
}
