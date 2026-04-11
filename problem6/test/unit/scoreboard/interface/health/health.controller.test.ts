import type { Registry } from 'prom-client';

import { HealthController } from '../../../../../src/scoreboard/interface/health/health.controller';
import type { HealthService } from '../../../../../src/scoreboard/infrastructure/health/health.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeHealth(overrides: Partial<HealthService> = {}): HealthService {
  return {
    pingPostgres: jest.fn().mockResolvedValue({ ok: true }),
    pingRedis: jest.fn().mockResolvedValue({ ok: true }),
    pingNats: jest.fn().mockResolvedValue({ ok: true }),
    get leaderboardReady() {
      return true;
    },
    ...overrides,
  } as unknown as HealthService;
}

function makeRegistry(metricsText = '# HELP test\n# TYPE test counter\ntest 1\n'): Registry {
  return {
    metrics: jest.fn().mockResolvedValue(metricsText),
  } as unknown as Registry;
}

type RawMock = {
  writeHead: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
};

interface ReplyMock {
  status: jest.Mock;
  send: jest.Mock;
  raw: RawMock;
  _statusCode?: number;
  _body?: unknown;
}

function makeReply(): ReplyMock {
  const reply: ReplyMock = {
    status: jest.fn(),
    send: jest.fn(),
    raw: {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    },
  };
  reply.status.mockImplementation((code: number) => {
    reply._statusCode = code;
    return reply;
  });
  reply.send.mockImplementation((body: unknown) => {
    reply._body = body;
    return reply;
  });
  return reply;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HealthController', () => {
  describe('GET /health (liveness)', () => {
    it('returns { status: "ok" } unconditionally', () => {
      const controller = new HealthController(makeHealth(), makeRegistry());
      expect(controller.liveness()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /ready', () => {
    it('returns 200 with all checks up when everything healthy', async () => {
      const controller = new HealthController(makeHealth(), makeRegistry());
      const reply = makeReply();

      await controller.ready(reply as never);

      expect(reply._statusCode).toBe(200);
      expect(reply._body).toEqual({
        checks: {
          postgres: 'up',
          redis: 'up',
          nats: 'up',
          leaderboard: 'ready',
        },
      });
    });

    it('returns 503 when postgres is down', async () => {
      const controller = new HealthController(
        makeHealth({ pingPostgres: jest.fn().mockResolvedValue({ ok: false, reason: 'timeout' }) }),
        makeRegistry(),
      );
      const reply = makeReply();

      await controller.ready(reply as never);

      expect(reply._statusCode).toBe(503);
      expect((reply._body as { checks: Record<string, string> }).checks.postgres).toBe('down');
      expect((reply._body as { checks: Record<string, string> }).checks.redis).toBe('up');
    });

    it('returns 503 when redis is down', async () => {
      const controller = new HealthController(
        makeHealth({ pingRedis: jest.fn().mockResolvedValue({ ok: false }) }),
        makeRegistry(),
      );
      const reply = makeReply();

      await controller.ready(reply as never);

      expect(reply._statusCode).toBe(503);
      expect((reply._body as { checks: Record<string, string> }).checks.redis).toBe('down');
    });

    it('returns 503 when nats is down', async () => {
      const controller = new HealthController(
        makeHealth({ pingNats: jest.fn().mockResolvedValue({ ok: false }) }),
        makeRegistry(),
      );
      const reply = makeReply();

      await controller.ready(reply as never);

      expect(reply._statusCode).toBe(503);
      expect((reply._body as { checks: Record<string, string> }).checks.nats).toBe('down');
    });

    it('returns 503 with leaderboard: rebuilding when leaderboard not ready', async () => {
      const controller = new HealthController(
        makeHealth({
          get leaderboardReady() {
            return false;
          },
        } as Partial<HealthService>),
        makeRegistry(),
      );
      const reply = makeReply();

      await controller.ready(reply as never);

      expect(reply._statusCode).toBe(503);
      expect((reply._body as { checks: Record<string, string> }).checks.leaderboard).toBe(
        'rebuilding',
      );
    });
  });

  describe('GET /metrics', () => {
    it('writes Prometheus text with correct Content-Type via raw reply', async () => {
      const metricsText = '# HELP scoreboard_test\n# TYPE scoreboard_test counter\nscoreboard_test 42\n';
      const controller = new HealthController(makeHealth(), makeRegistry(metricsText));
      const reply = makeReply();

      await controller.metrics(reply as never);

      expect(reply.raw.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      expect(reply.raw.write).toHaveBeenCalledWith(metricsText);
      expect(reply.raw.end).toHaveBeenCalled();
    });
  });
});
