import type pino from 'pino';

type ShutdownHook = () => Promise<void>;

export class ShutdownManager {
  private readonly hooks: ShutdownHook[] = [];
  private readonly timeoutMs: number;
  private readonly logger: pino.Logger;
  private shutdownInitiated = false;

  constructor(timeoutMs: number, logger: pino.Logger) {
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  register(hook: ShutdownHook): void {
    this.hooks.push(hook);
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shutdownInitiated) return;
    this.shutdownInitiated = true;

    this.logger.info({ signal }, 'Shutdown initiated — draining connections');

    const timeoutHandle = setTimeout(() => {
      this.logger.warn(
        { timeoutMs: this.timeoutMs },
        'Graceful shutdown timeout exceeded — forcing exit',
      );
      process.exit(1);
    }, this.timeoutMs);

    try {
      await Promise.all(this.hooks.map((hook) => hook()));
      clearTimeout(timeoutHandle);
      this.logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      clearTimeout(timeoutHandle);
      this.logger.error({ err }, 'Error during shutdown hooks — forcing exit');
      process.exit(1);
    }
  }

  listen(): void {
    const handler = (signal: string) => () => void this.shutdown(signal);
    process.on('SIGTERM', handler('SIGTERM'));
    process.on('SIGINT', handler('SIGINT'));
  }
}
