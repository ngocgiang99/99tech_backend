import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { ShutdownManager } from './lib/shutdown.js';
import { createDb } from './db/client.js';
import { createRedis } from './cache/client.js';
import { createApp } from './app.js';

function main(): void {
  // 1. Load + validate configuration (exits on failure)
  const config = loadConfig();

  // 2. Initialize logger
  const logger = createLogger(config);

  // 3. Create real clients
  const { db, pool } = createDb({
    connectionString: config.DATABASE_URL,
    maxConnections: config.DB_POOL_MAX,
  });

  const redis = createRedis({ url: config.REDIS_URL });
  redis.on('error', (err) => {
    logger.warn({ err: err.message }, 'Redis client error');
  });

  // 4. Build the app from injected deps
  const { app } = createApp({ config, logger, db, redis });

  // 5. Start HTTP listener
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, cacheEnabled: config.CACHE_ENABLED },
      'Server listening',
    );
  });

  // 6. Register shutdown hooks (reverse-of-startup order)
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

  // 7. Listen for termination signals
  shutdownManager.listen();
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`[fatal] Unhandled error during startup: ${String(err)}\n`);
  process.exit(1);
}
