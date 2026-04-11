import { ArgumentsHost, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

import { HttpExceptionFilter } from '../../../../src/scoreboard/interface/http/error-filter';
import { InvalidArgumentError } from '../../../../src/scoreboard/domain/errors/invalid-argument.error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(requestId?: string): {
  host: ArgumentsHost;
  statusMock: jest.Mock;
  sendMock: jest.Mock;
} {
  const sendMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ send: sendMock });

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId }),
      getResponse: () => ({ status: statusMock }),
    }),
  } as unknown as ArgumentsHost;

  return { host, statusMock, sendMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  describe('ZodError', () => {
    it('returns 400 INVALID_ARGUMENT with zod issue messages joined', () => {
      const { z } = require('zod');
      const schema = z.object({ name: z.string().min(1) });
      let zodErr: ZodError | undefined;
      try {
        schema.parse({ name: '' });
      } catch (e) {
        zodErr = e as ZodError;
      }

      const { host, statusMock, sendMock } = makeHost('req-123');
      filter.catch(zodErr!, host);

      expect(statusMock).toHaveBeenCalledWith(400);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('INVALID_ARGUMENT');
      expect(body.error.requestId).toBe('req-123');
    });
  });

  describe('InvalidArgumentError', () => {
    it('returns 400 INVALID_ARGUMENT with the error message', () => {
      const err = new InvalidArgumentError('bad input');
      const { host, statusMock, sendMock } = makeHost('req-456');
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(400);
      const body = sendMock.mock.calls[0][0];
      expect(body.error.code).toBe('INVALID_ARGUMENT');
      expect(body.error.message).toBe('bad input');
      expect(body.error.requestId).toBe('req-456');
    });
  });

  describe('HttpException (client 4xx)', () => {
    it('returns the correct status and code for 401', () => {
      const err = new HttpException('Unauthorized', 401);
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(sendMock.mock.calls[0][0].error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 FORBIDDEN', () => {
      const err = new HttpException('Forbidden', 403);
      const { host, statusMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(403);
    });

    it('returns 404 NOT_FOUND', () => {
      const err = new HttpException('Not Found', 404);
      const { host, statusMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(404);
    });

    it('returns 409 CONFLICT', () => {
      const err = new HttpException('Conflict', 409);
      const { host, statusMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(409);
    });

    it('returns 429 RATE_LIMITED', () => {
      const err = new HttpException('Too many requests', 429);
      const { host, statusMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(429);
    });

    it('returns 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new HttpException('Service unavailable', 503);
      const { host, statusMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(503);
    });

    it('returns HTTP_ERROR for unknown 4xx', () => {
      const err = new HttpException('I am a teapot', 418);
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);
      expect(statusMock).toHaveBeenCalledWith(418);
      expect(sendMock.mock.calls[0][0].error.code).toBe('HTTP_ERROR');
    });

    it('extracts message from object response body', () => {
      const err = new HttpException({ message: 'INVALID_ACTION_TOKEN' }, 403);
      const { host, sendMock } = makeHost();
      filter.catch(err, host);
      expect(sendMock.mock.calls[0][0].error.message).toBe('INVALID_ACTION_TOKEN');
    });

    it('extracts message from string response body', () => {
      const err = new HttpException('plain-string-error', 400);
      const { host, sendMock } = makeHost();
      filter.catch(err, host);
      expect(sendMock.mock.calls[0][0].error.message).toBe('plain-string-error');
    });
  });

  describe('HttpException (5xx)', () => {
    it('returns 500 INTERNAL_ERROR with generic message for 500', () => {
      const err = new HttpException('internal detail', 500);
      const { host, statusMock, sendMock } = makeHost();
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(sendMock.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
      expect(sendMock.mock.calls[0][0].error.message).toBe('Internal server error');
    });
  });

  describe('unhandled Error', () => {
    it('returns 500 INTERNAL_ERROR for generic Error', () => {
      const err = new Error('something broke');
      const { host, statusMock, sendMock } = makeHost('req-789');
      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(sendMock.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
      expect(sendMock.mock.calls[0][0].error.message).toBe('Internal server error');
      expect(sendMock.mock.calls[0][0].error.requestId).toBe('req-789');
    });
  });

  describe('unknown thrown value', () => {
    it('returns 500 INTERNAL_ERROR for non-Error thrown values', () => {
      const { host, statusMock, sendMock } = makeHost();
      filter.catch('some string error', host);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(sendMock.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
    });

    it('handles null thrown value', () => {
      const { host, statusMock } = makeHost();
      filter.catch(null, host);
      expect(statusMock).toHaveBeenCalledWith(500);
    });
  });

  describe('requestId is null when not present', () => {
    it('sets requestId to null when request has no requestId', () => {
      const err = new HttpException('Not found', 404);
      const { host, sendMock } = makeHost(undefined);
      filter.catch(err, host);
      expect(sendMock.mock.calls[0][0].error.requestId).toBeNull();
    });
  });

  describe('Redis infrastructure errors (GAP-03 fail-CLOSED)', () => {
    it('maps MaxRetriesPerRequestError name to 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new Error('Reached the max retries per request limit (which is 1)');
      err.name = 'MaxRetriesPerRequestError';
      const { host, statusMock, sendMock } = makeHost('req-redis-1');

      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(sendMock.mock.calls[0][0].error.code).toBe('TEMPORARILY_UNAVAILABLE');
      expect(sendMock.mock.calls[0][0].error.message).toBe('Service temporarily unavailable');
    });

    it('maps ECONNREFUSED to 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
      const { host, statusMock, sendMock } = makeHost('req-redis-2');

      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(sendMock.mock.calls[0][0].error.code).toBe('TEMPORARILY_UNAVAILABLE');
    });

    it('maps ENOTFOUND to 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new Error('getaddrinfo ENOTFOUND problem6-redis');
      const { host, statusMock, sendMock } = makeHost('req-redis-3');

      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(sendMock.mock.calls[0][0].error.code).toBe('TEMPORARILY_UNAVAILABLE');
    });

    it('maps AbortError to 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new Error('Command aborted due to connection close');
      err.name = 'AbortError';
      const { host, statusMock } = makeHost('req-redis-4');

      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(503);
    });

    it('maps "Connection is closed" to 503 TEMPORARILY_UNAVAILABLE', () => {
      const err = new Error('Connection is closed.');
      const { host, statusMock, sendMock } = makeHost('req-redis-5');

      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(sendMock.mock.calls[0][0].error.code).toBe('TEMPORARILY_UNAVAILABLE');
    });

    it('does NOT map unrelated Error messages to 503', () => {
      const err = new Error('Something unrelated broke');
      const { host, statusMock, sendMock } = makeHost('req-generic');

      filter.catch(err, host);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(sendMock.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
    });
  });
});
