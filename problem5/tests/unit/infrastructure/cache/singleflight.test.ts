import { describe, expect, it, vi } from 'vitest';

import { Singleflight } from '../../../../src/infrastructure/cache/singleflight.js';

describe('Singleflight', () => {
  it('coalesces N concurrent calls into a single fn invocation', async () => {
    const sf = new Singleflight<number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    const results = await Promise.all([
      sf.do('k', fn),
      sf.do('k', fn),
      sf.do('k', fn),
      sf.do('k', fn),
      sf.do('k', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(results).toEqual([42, 42, 42, 42, 42]);
  });

  it('propagates rejections to all concurrent waiters', async () => {
    const sf = new Singleflight<number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('boom');
    });

    const results = await Promise.allSettled([
      sf.do('k', fn),
      sf.do('k', fn),
      sf.do('k', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect((r.reason as Error).message).toBe('boom');
      }
    }
  });

  it('clears the in-flight entry on resolve so subsequent calls run fn again', async () => {
    const sf = new Singleflight<number>();
    const fn = vi.fn(async () => 7);

    await sf.do('k', fn);
    expect(sf.size()).toBe(0);
    await sf.do('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry on reject so subsequent calls run fn again', async () => {
    const sf = new Singleflight<number>();
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first fail');
      return 99;
    });

    await expect(sf.do('k', fn)).rejects.toThrow('first fail');
    expect(sf.size()).toBe(0);
    const result = await sf.do('k', fn);
    expect(result).toBe(99);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct keys independent', async () => {
    const sf = new Singleflight<string>();
    const fnA = vi.fn(async () => 'A');
    const fnB = vi.fn(async () => 'B');

    const [a, b] = await Promise.all([sf.do('a', fnA), sf.do('b', fnB)]);
    expect(a).toBe('A');
    expect(b).toBe('B');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('times out a slow call and rejects with a timeout error', async () => {
    const sf = new Singleflight<number>({ timeoutMs: 20 });
    const fn = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(1), 200);
        }),
    );

    await expect(sf.do('slow', fn)).rejects.toThrow(/timed out/);
    expect(sf.size()).toBe(0);
  });
});
