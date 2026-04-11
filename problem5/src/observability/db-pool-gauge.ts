import type pg from 'pg';

import type { MetricsRegistry } from './metrics-registry.js';

const SAMPLE_INTERVAL_MS = 5_000;

/**
 * Background sampler that polls `pg.Pool` connection counts every 5 seconds
 * and updates the `db_pool_size{state}` gauge. Returns a handle with `stop()`
 * to register on the shutdown manager.
 */
export function startDbPoolGauge(
  pool: pg.Pool,
  metrics: MetricsRegistry,
): { stop: () => void } {
  const sample = (): void => {
    metrics.dbPoolSize.set({ state: 'total' }, pool.totalCount);
    metrics.dbPoolSize.set({ state: 'idle' }, pool.idleCount);
    metrics.dbPoolSize.set({ state: 'waiting' }, pool.waitingCount);
  };

  // Take an initial sample so a scrape immediately after startup sees real values.
  sample();
  const handle = setInterval(sample, SAMPLE_INTERVAL_MS);
  // Don't keep the event loop alive for this timer — the process should exit
  // cleanly when all real work is done.
  handle.unref();

  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}
