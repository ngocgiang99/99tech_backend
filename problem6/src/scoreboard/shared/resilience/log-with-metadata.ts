import { randomUUID } from 'node:crypto';

import { buildBackgroundErrorMetadata, wrapUnknown } from '../errors';

export type LogLevel = 'warn' | 'error' | 'fatal';

export interface StructuredLogger {
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
  fatal?: (obj: object, msg?: string) => void;
}

export function logWithMetadata(
  logger: StructuredLogger,
  level: LogLevel,
  err: unknown,
  context: Record<string, unknown> = {},
): void {
  const source =
    typeof context['source'] === 'string' ? context['source'] : undefined;

  const appErr = wrapUnknown(err);
  const metadata = buildBackgroundErrorMetadata(
    appErr,
    { source },
    randomUUID(),
  );

  const emit =
    level === 'fatal' && typeof logger.fatal !== 'function'
      ? logger.error
      : (logger[level] ?? logger.error);

  emit.call(
    logger,
    { err: metadata, ...context },
    'Error logged with metadata',
  );
}
