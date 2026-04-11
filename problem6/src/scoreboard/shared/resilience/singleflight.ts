export interface SingleflightOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

export class Singleflight<T> {
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly timeoutMs: number;

  constructor(options: SingleflightOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const wrapped = this.runWithTimeout(fn).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, wrapped);
    return wrapped;
  }

  size(): number {
    return this.inflight.size;
  }

  private runWithTimeout(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`singleflight: timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();

      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}
