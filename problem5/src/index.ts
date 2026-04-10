import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { HealthCheckRegistry } from './lib/health.js';
import { ShutdownManager } from './lib/shutdown.js';
import { buildApp } from './http/app.js';

function main(): void {
  // 1. Load + validate configuration (exits on failure)
  const config = loadConfig();

  // 2. Initialize logger
  const logger = createLogger(config);

  // 3. Set up registries
  const healthRegistry = new HealthCheckRegistry();
  const shutdownManager = new ShutdownManager(config.SHUTDOWN_TIMEOUT_MS, logger);

  // 4. Build Express app
  const app = buildApp(logger, healthRegistry);

  // 5. Start HTTP listener
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Server listening');
  });

  // 6. Register shutdown hooks
  shutdownManager.register(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  // 7. Listen for termination signals
  shutdownManager.listen();
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`[fatal] Unhandled error during startup: ${String(err)}\n`);
  process.exit(1);
}
