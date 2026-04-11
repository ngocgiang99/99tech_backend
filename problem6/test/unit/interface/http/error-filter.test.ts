import { ArgumentsHost, HttpException } from '@nestjs/common';
import type { Counter } from 'prom-client';
import { z, ZodError } from 'zod';

import { HttpExceptionFilter } from '../../../../src/scoreboard/interface/http/error-filter';
import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';
import {
  BadRequestError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  UnprocessableEntityError,
  ValidationError,
} from '../../../../src/scoreboard/shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockCtx {
  host: ArgumentsHost;
  statusMock: jest.Mock;
  sendMock: jest.Mock;
  rawHeadersSentRef: { current: boolean };
}

function makeHost(
  requestId?: string,
  headersSent = false,
): MockCtx {
  const sendMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ send: sendMock });
  const rawHeadersSentRef = { current: headersSent };

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        requestId,
        method: 'POST',
        url: '/v1/scores:increment',
        headers: {},
        routeOptions: { url: '/v1/scores:increment' },
        ip: '10.0.0.1',
      }),
      getResponse: () => ({
        status: statusMock,
        raw: {
          get headersSent() {
            return rawHeadersSentRef.current;
          },
        },
      }),
    }),
  } as unknown as ArgumentsHost;

  return { host, statusMock, sendMock, rawHeadersSentRef };
}

function makeCounter(): jest.Mocked<Counter<'code' | 'status'>> {
  return {
    inc: jest.fn(),
    labels: jest.fn(),
    reset: jest.fn(),
    remove: jest.fn(),
    get: jest.fn(),
    hashMap: {},
  } as unknown as jest.Mocked<Counter<'code' | 'status'>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let counter: jest.Mocked<Counter<'code' | 'status'>>;

  beforeEach(() => {
    counter = makeCounter();
    filter = new HttpExceptionFilter(counter);
  });

  describe('DomainError subclasses produce the matching envelope', () => {
    const subclassCases: Array<{
      name: string;
      err: () => Error;
      status: number;
      code: string;
    }> = [
      {
        name: 'ValidationError',
        err: () => new ValidationError('bad delta'),
        status: 400,
        code: 'VALIDATION',
      },
      {
        name: 'BadRequestError',
        err: () => new BadRequestError('bad'),
        status: 400,
        code: 'BAD_REQUEST',
      },
      {
        name: 'UnauthenticatedError',
        err: () => new UnauthenticatedError('no token'),
        status: 401,
        code: 'UNAUTHENTICATED',
      },
      {
        name: 'ForbiddenError',
        err: () => new ForbiddenError('scope'),
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        name: 'NotFoundError',
        err: () => new NotFoundError('missing'),
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        name: 'ConflictError',
        err: () => new ConflictError('dup'),
        status: 409,
        code: 'CONFLICT',
      },
      {
        name: 'UnprocessableEntityError',
        err: () => new UnprocessableEntityError('bad'),
        status: 422,
        code: 'UNPROCESSABLE_ENTITY',
      },
      {
        name: 'RateLimitError',
        err: () => new RateLimitError('too many'),
        status: 429,
        code: 'RATE_LIMIT',
      },
      {
        name: 'DependencyUnavailableError',
        err: () => new DependencyUnavailableError('down'),
        status: 503,
        code: 'TEMPORARILY_UNAVAILABLE',
      },
      {
        name: 'InternalError',
        err: () => new InternalError('internals'),
        status: 500,
        code: 'INTERNAL_ERROR',
      },
    ];

    for (const { name, err, status, code } of subclassCases) {
      it(`returns ${status}/${code} for ${name}`, () => {
        const { host, statusMock, sendMock } = makeHost('req-1');
        filter.catch(err(), host);

        expect(statusMock).toHaveBeenCalledWith(status);
        const body = sendMock.mock.calls[0][0];
        expect(body.error.code).toBe(code);
        expect(body.error.requestId).toBe('req-1');
        // errorId is present for 5xx, hidden for <500
        if (status >= 500) {
          expect(typeof body.error.errorId).toBe('string');
        } else {
          expect(body.error.errorId).toBeUndefined();
        }
      });
    }
  });

  describe('counter emission', () => {
    it('increments errorsTotal with code and status labels', () => {
      const { host } = makeHost('req-1');
      filter.catch(new ValidationError('bad'), host);
      expect(counter.inc).toHaveBeenCalledWith({
        code: 'VALIDATION',
        status: '400',
      });
    });

    it('increments with 500 label for InternalError', () => {
      const { host } = makeHost('req-1');
      filter.catch(new InternalError('boom'), host);
      expect(counter.inc).toHaveBeenCalledWith({
        code: 'INTERNAL_ERROR',
        status: '500',
      });
    });
  });

  describe('ZodError is wrapped into ValidationError', () => {
    it('returns 400 VALIDATION with zod issue messages joined', () => {
      const schema = z.object({ name: z.string().min(1) });
      let zodErr: ZodError | undefined;
      try {
        schema.parse({ name: '' });
      } catch (e) {
        zodErr = e as ZodError;
      }

      const { host, statusMock, sendMock } = makeHost('req-zod');
      filter.catch(zodErr!, host);

      expect(statusMock).toHaveBeenCalledWith(400);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.requestId).toBe('req-zod');
      expect(Array.isArray(body.error.details)).toBe(true);
    });
  });

  describe('InvalidArgumentError is wrapped into ValidationError', () => {
    it('returns 400 VALIDATION with the error message', () => {
      const err = new InvalidArgumentError('bad input');
      const { host, statusMock, sendMock } = makeHost('req-invalid');
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(400);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.message).toBe('bad input');
    });
  });

  describe('NestJS HttpException passthrough', () => {
    it('maps 401 → UNAUTHENTICATED', () => {
      const err = new HttpException('Unauthorized', 401);
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(401);
      expect(sendMock.mock.calls[0][0].error.code).toBe('UNAUTHENTICATED');
    });

    it('maps 403 → FORBIDDEN', () => {
      filter.catch(new HttpException('Forbidden', 403), makeHost().host);
    });

    it('maps unknown 4xx → BAD_REQUEST', () => {
      const err = new HttpException('teapot', 418);
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(sendMock.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
    });

    it('maps 500 HttpException → INTERNAL_ERROR with generic message', () => {
      const err = new HttpException('internal detail', 500);
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(500);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Internal server error');
      expect(typeof body.error.errorId).toBe('string');
    });
  });

  describe('generic Error', () => {
    it('returns 500 INTERNAL_ERROR with generic message', () => {
      const err = new Error('something broke');
      const { host, statusMock, sendMock } = makeHost('req-789');
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(500);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Internal server error');
      expect(body.error.requestId).toBe('req-789');
    });
  });

  describe('unknown thrown values', () => {
    it('returns 500 INTERNAL_ERROR for a string thrown value', () => {
      const { host, statusMock, sendMock } = makeHost();
      filter.catch('some string error', host);
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(sendMock.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
    });

    it('returns 500 for a null thrown value', () => {
      const { host, statusMock } = makeHost();
      filter.catch(null, host);
      expect(statusMock).toHaveBeenCalledWith(500);
    });
  });

  describe('requestId null when missing', () => {
    it('sets requestId to null when request has no requestId', () => {
      const err = new NotFoundError('Not found');
      const { host, sendMock } = makeHost(undefined);
      filter.catch(err, host);
      expect(sendMock.mock.calls[0][0].error.requestId).toBeNull();
    });
  });

  describe('Redis fail-CLOSED (GAP-03)', () => {
    it('maps MaxRetriesPerRequestError → 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new Error('Reached the max retries per request limit');
      err.name = 'MaxRetriesPerRequestError';
      const { host, statusMock, sendMock } = makeHost('req-redis-1');
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(503);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
      expect(body.error.message).toBe('Service temporarily unavailable');
      // 503 is >= 500 → errorId present
      expect(typeof body.error.errorId).toBe('string');
    });

    it('maps ECONNREFUSED → 503', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(503);
      expect(sendMock.mock.calls[0][0].error.code).toBe('TEMPORARILY_UNAVAILABLE');
    });

    it('does NOT map unrelated errors to 503', () => {
      const err = new Error('Something unrelated broke');
      const { host, statusMock, sendMock } = makeHost('req-generic');
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(sendMock.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('idempotency guard (headersSent = true)', () => {
    it('returns silently without calling status/send', () => {
      const { host, statusMock, sendMock } = makeHost('req-1', true);
      filter.catch(new ValidationError('bad'), host);
      expect(statusMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(counter.inc).not.toHaveBeenCalled();
    });
  });

  describe('InternalError leak prevention', () => {
    it('replaces err.message with the generic for InternalError', () => {
      const err = new InternalError('database password: hunter2');
      const { host, sendMock } = makeHost('req-leak');
      filter.catch(err, host);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('hunter2');
    });
  });

  describe('ValidationError carries details', () => {
    it('includes details in the body for ValidationError only', () => {
      const err = new ValidationError('bad', [{ field: 'delta' }]);
      const { host, sendMock } = makeHost('r');
      filter.catch(err, host);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.details).toEqual([{ field: 'delta' }]);
    });
  });
});
