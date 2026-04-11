import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { InvalidArgumentError } from '../../domain/errors/invalid-argument.error';

// NOTE: The following domain error classes do not yet exist in this codebase
// (NotFoundError, ConflictError, UnauthorizedError, ForbiddenError). They are
// listed here as placeholders. When those classes are added, import them and
// add instanceof checks in the switch-like block below.

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string | null;
    hint?: string | null;
  };
}

function deriveHttpExceptionCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'TEMPORARILY_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest & { requestId?: string }>();
    const reply = ctx.getResponse<FastifyReply>();

    const requestId = request.requestId ?? null;

    let status: number;
    let code: string;
    let safeMessage: string;
    const hint: string | null = null;

    if (exception instanceof ZodError) {
      status = 400;
      code = 'INVALID_ARGUMENT';
      safeMessage = exception.issues.map((issue) => issue.message).join('; ');
    } else if (exception instanceof InvalidArgumentError) {
      status = 400;
      code = 'INVALID_ARGUMENT';
      safeMessage = exception.message;
    } else if (exception instanceof HttpException) {
      // NestJS-wrapped HTTP exceptions (including those thrown by guards/pipes)
      status = exception.getStatus();
      code = deriveHttpExceptionCode(status);
      // For client errors (4xx), the NestJS message is safe to forward.
      // For server errors (5xx), use a generic message.
      if (status >= 500) {
        safeMessage = 'Internal server error';
        this.logger.error(
          `[${requestId}] HttpException ${status}: ${exception.message}`,
          exception.stack,
        );
      } else {
        const responseBody = exception.getResponse();
        if (typeof responseBody === 'string') {
          safeMessage = responseBody;
        } else if (
          typeof responseBody === 'object' &&
          responseBody !== null &&
          'message' in responseBody
        ) {
          const msg = (responseBody as { message: unknown }).message;
          safeMessage = typeof msg === 'string' ? msg : JSON.stringify(msg);
        } else {
          safeMessage = exception.message;
        }
      }
    } else if (exception instanceof Error) {
      // Unhandled domain / infrastructure errors → 500
      status = 500;
      code = 'INTERNAL_ERROR';
      safeMessage = 'Internal server error';
      this.logger.error(
        `[${requestId}] Unhandled error: ${exception.message}`,
        exception.stack,
      );
    } else {
      status = 500;
      code = 'INTERNAL_ERROR';
      safeMessage = 'Internal server error';
      this.logger.error(
        `[${requestId}] Unknown thrown value: ${String(exception)}`,
      );
    }

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message: safeMessage,
        requestId,
        hint,
      },
    };

    void reply.status(status).send(envelope);
  }
}
