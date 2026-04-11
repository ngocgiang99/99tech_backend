import { loadConfig } from './config/env.js';
import { createLogger } from './shared/logger.js';
import { ShutdownManager } from './shared/shutdown.js';
import { createDb } from './infrastructure/db/client.js';
import { createRedis } from './infrastructure/cache/client.js';
import { MetricsRegistry } from './observability/metrics-registry.js';
import { createDbMetricsLogger } from './observability/db-metrics.js';
import { startDbPoolGauge } from './observability/db-pool-gauge.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  // 1. Load + validate configuration (exits on failure)
  const config = loadConfig();

  // 2. Initialize logger
  const logger = createLogger(config);

  // 3. Construct the metrics registry early so the db client can use the
  //    Kysely log callback. When METRICS_ENABLED=false, we still construct
  //    it (cheap) but the wiring layer doesn't mount the route or middleware.
  const metrics = new MetricsRegistry({ collectDefaults: config.METRICS_DEFAULT_METRICS });

  // 4. Create real clients — db gets the metrics-emitting log callback when
  //    metrics are enabled, so every query observation flows into the
  //    db_query_duration_seconds histogram and errors flow into
  //    db_query_errors_total.
  const { db, pool } = createDb({
    connectionString: config.DATABASE_URL,
    maxConnections: config.DB_POOL_MAX,
    ...(config.METRICS_ENABLED ? { log: createDbMetricsLogger(metrics) } : {}),
  });

  const redis = createRedis({ url: config.REDIS_URL });
  redis.on('error', (err) => {
    logger.warn({ err: err.message }, 'Redis client error');
  });

  // 4b. Wait for the Redis client to finish its TCP handshake before
  //     constructing the app. The rate-limit-redis store (s12) issues
  //     commands during its constructor via `loadIncrementScript`, and
  //     ioredis is configured with `enableOfflineQueue: false` — so any
  //     command issued before the `ready` event rejects with "Stream
  //     isn't writeable". Matching the integration fixture's pattern
  //     here keeps the dev compose healthcheck deterministic.
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        redis.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        redis.off('ready', onReady);
        reject(err);
      };
      redis.once('ready', onReady);
      redis.once('error', onError);
    });
  }

  // 5. Start the pool-size sampler (5s interval, unref'd so it never holds
  //    the event loop open). No-op when metrics are disabled — we still
  //    start it cheaply but the gauge is never scraped.
  const dbPoolGauge = config.METRICS_ENABLED
    ? startDbPoolGauge(pool, metrics)
    : { stop: () => {} };

  // 6. Build the app from injected deps
  const { app } = createApp({ config, logger, db, redis, metrics });

  // 7. Start HTTP listener
  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        cacheEnabled: config.CACHE_ENABLED,
        metricsEnabled: config.METRICS_ENABLED,
      },
      'Server listening',
    );
  });

  // 8. Register shutdown hooks (reverse-of-startup order)
  const shutdownManager = new ShutdownManager(config.SHUTDOWN_TIMEOUT_MS, logger);
  shutdownManager.register(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );
  shutdownManager.register(async () => {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  });
  shutdownManager.register(() => pool.end());
  shutdownManager.register(() => {
    dbPoolGauge.stop();
    metrics.clear();
    return Promise.resolve();
  });

  // 9. Listen for termination signals
  shutdownManager.listen();
}

main().catch((err: unknown) => {
  process.stderr.write(`[fatal] Unhandled error during startup: ${String(err)}\n`);
  process.exit(1);
});
