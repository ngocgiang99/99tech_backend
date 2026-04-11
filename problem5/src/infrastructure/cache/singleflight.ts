const DEFAULT_TIMEOUT_MS = 3000;

export interface SingleflightOptions {
  timeoutMs?: number;
}

/**
 * In-process singleflight: concurrent callers asking for the same key share
 * the same in-flight promise so only one upstream call runs per (process, key).
 *
 * Entries are cleared on both resolve and reject. A per-call timeout rejects
 * the shared promise and clears the entry so the next caller can retry.
 */
export class Singleflight<T> {
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly timeoutMs: number;

  constructor(options: SingleflightOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.runWithTimeout(fn).finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  private runWithTimeout(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`singleflight: timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
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

  size(): number {
    return this.inflight.size;
  }
}
