import {
  Controller,
  Get,
  Inject,
  Logger,
  OnApplicationShutdown,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ConfigService } from '../../../../config';
import {
  LEADERBOARD_CACHE_TOKEN,
  type LeaderboardCache,
} from '../../../domain';
import {
  LEADERBOARD_UPDATES_PORT,
  type LeaderboardUpdateEvent,
  type LeaderboardUpdatesPort,
} from '../../../domain/ports/leaderboard-updates.port';
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
import {
  type AuthenticatedRequest,
  peekAuthenticatedUserId,
} from '../authenticated-request';

const SHUTDOWN_FRAME = 'event: shutdown\ndata: {"reason":"graceful"}\n\n';

@Controller('v1/leaderboard')
@UseGuards(JwtGuard)
export class LeaderboardStreamController implements OnApplicationShutdown {
  private static currentConnections = 0;

  private readonly logger = new Logger(LeaderboardStreamController.name);
  private readonly openStreams = new Set<FastifyReply>();

  constructor(
    @Inject(LEADERBOARD_CACHE_TOKEN) private readonly cache: LeaderboardCache,
    @Inject(LEADERBOARD_UPDATES_PORT)
    private readonly updates: LeaderboardUpdatesPort,
    private readonly config: ConfigService,
  ) {}

  @Get('stream')
  async stream(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const maxConn = this.config.get('MAX_SSE_CONN_PER_INSTANCE');
    if (LeaderboardStreamController.currentConnections >= maxConn) {
      void reply.status(503).send({
        error: {
          code: 'TEMPORARILY_UNAVAILABLE',
          message: 'SSE connection cap reached on this instance',
          requestId: null,
          hint: 'Retry against a different instance or try again later',
        },
      });
      return;
    }

    LeaderboardStreamController.currentConnections += 1;
    this.openStreams.add(reply);

    // Set SSE headers via reply.raw — bypasses Fastify's serialization
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const MAX_PENDING = this.config.get(
      'SSE_BACKPRESSURE_MAX_PENDING_MESSAGES',
    );
    const TIMEOUT = this.config.get('SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS');
    const HEARTBEAT_MS = this.config.get('SSE_HEARTBEAT_INTERVAL_MS');

    const pendingMessages: string[] = [];
    let bufferFullSince: number | null = null;
    let connectionOpen = true;

    const writeFrame = (event: string, data: unknown): void => {
      if (!connectionOpen) {
        return;
      }

      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      // Drop-oldest if over cap
      if (pendingMessages.length >= MAX_PENDING) {
        pendingMessages.shift();
      }
      pendingMessages.push(frame);

      // Track when buffer became full
      if (pendingMessages.length >= MAX_PENDING && bufferFullSince === null) {
        bufferFullSince = Date.now();
      }

      reply.raw.write(frame, (err) => {
        if (err) {
          this.logger.debug(
            { err },
            'sse write error — connection likely closed',
          );
          cleanup();
          return;
        }
        // On successful write, remove from pending
        const idx = pendingMessages.indexOf(frame);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
        }
        // If buffer is no longer full, reset the timer
        if (pendingMessages.length < MAX_PENDING) {
          bufferFullSince = null;
        }
      });
    };

    const cleanup = (): void => {
      if (!connectionOpen) {
        return;
      }
      connectionOpen = false;
      clearInterval(heartbeatTimer);
      clearInterval(slowClientTimer);
      unsubscribe();
      LeaderboardStreamController.currentConnections -= 1;
      this.openStreams.delete(reply);
      try {
        reply.raw.end();
      } catch {
        // already ended — ignore
      }
    };

    // Send initial snapshot
    try {
      const top = await this.cache.getTop(10);
      writeFrame('snapshot', { top });
    } catch (e) {
      this.logger.error(
        { err: e },
        'failed to fetch initial leaderboard snapshot',
      );
      writeFrame('snapshot', { top: [] });
    }

    // Subscribe to in-process updates port
    const unsubscribe = this.updates.subscribe(
      (event: LeaderboardUpdateEvent) => {
        writeFrame('leaderboard.updated', event);
      },
    );

    // Heartbeat timer
    const heartbeatTimer = setInterval(() => {
      if (!connectionOpen) {
        return;
      }
      reply.raw.write(`event: heartbeat\ndata: {}\n\n`);
    }, HEARTBEAT_MS);

    // Slow-client disconnect timer
    const slowClientTimer = setInterval(() => {
      if (!connectionOpen) {
        return;
      }
      if (bufferFullSince !== null && Date.now() - bufferFullSince >= TIMEOUT) {
        const userId = peekAuthenticatedUserId(req);
        this.logger.warn(
          { userId },
          'sse slow client disconnected due to buffer timeout',
        );
        cleanup();
      } else if (pendingMessages.length < MAX_PENDING) {
        bufferFullSince = null;
      }
    }, 1000);

    // Listen for disconnect
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  }

  onApplicationShutdown(signal?: string): void {
    const count = this.openStreams.size;
    for (const reply of this.openStreams) {
      try {
        reply.raw.write(SHUTDOWN_FRAME);
        reply.raw.end();
      } catch {
        // Already closed — skip silently
      }
    }
    this.openStreams.clear();
    this.logger.log({ signal, count }, 'sse streams closed');
  }
}
