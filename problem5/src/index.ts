import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { HealthCheckRegistry } from './lib/health.js';
import { ShutdownManager } from './lib/shutdown.js';
import { buildApp } from './http/app.js';
import { createDb } from './db/client.js';
import { dbHealthCheck } from './db/health.js';
import { createRedis } from './cache/client.js';
import { cacheHealthCheck } from './cache/health.js';

function main(): void {
  // 1. Load + validate configuration (exits on failure)
  const config = loadConfig();

  // 2. Initialize logger
  const logger = createLogger(config);

  // 3. Create DB client
  const { db, pool } = createDb({
    connectionString: config.DATABASE_URL,
    maxConnections: config.DB_POOL_MAX,
  });

  // 4. Create Redis client
  const redis = createRedis({ url: config.REDIS_URL });
  redis.on('error', (err) => {
    logger.warn({ err: err.message }, 'Redis client error');
  });

  // 5. Set up registries
  const healthRegistry = new HealthCheckRegistry();
  const shutdownManager = new ShutdownManager(config.SHUTDOWN_TIMEOUT_MS, logger);

  // 6. Register health checks
  healthRegistry.register('db', dbHealthCheck(db));
  healthRegistry.register('cache', cacheHealthCheck(redis));

  // 7. Build Express app
  const app = buildApp(logger, healthRegistry, db, {
    redis,
    cacheEnabled: config.CACHE_ENABLED,
    detailTtlSeconds: config.CACHE_DETAIL_TTL_SECONDS,
    listTtlSeconds: config.CACHE_LIST_TTL_SECONDS,
    listVersionKeyPrefix: config.CACHE_LIST_VERSION_KEY_PREFIX,
    nodeEnv: config.NODE_ENV,
  });

  // 8. Start HTTP listener
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, cacheEnabled: config.CACHE_ENABLED },
      'Server listening',
    );
  });

  // 9. Register shutdown hooks (reverse-of-startup order)
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

  // 10. Listen for termination signals
  shutdownManager.listen();
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`[fatal] Unhandled error during startup: ${String(err)}\n`);
  process.exit(1);
}
