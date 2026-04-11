import pino from 'pino';

import type { Config } from '../config/env.js';

let _logger: pino.Logger | undefined;

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): pino.Logger {
  const logger = pino({
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino/file',
            options: { destination: 1 }, // stdout
          },
        }
      : {}),
  });

  _logger = logger;
  return logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    throw new Error('Logger has not been initialized. Call createLogger() first.');
  }
  return _logger;
}
