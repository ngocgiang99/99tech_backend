import { Singleflight } from '../../../../src/scoreboard/shared/resilience/singleflight';

describe('Singleflight', () => {
  describe('do()', () => {
    it('collapses 10 concurrent callers for the same key into one fn invocation', async () => {
      const sf = new Singleflight<string>();
      let calls = 0;
      const fn = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return 'value';
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, () => sf.do('k', fn)),
      );

      expect(calls).toBe(1);
      expect(results).toEqual(Array.from({ length: 10 }, () => 'value'));
      expect(sf.size()).toBe(0);
    });

    it('treats different keys as independent', async () => {
      const sf = new Singleflight<string>();
      let callsA = 0;
      let callsB = 0;
      const fnA = () => {
        callsA++;
        return Promise.resolve('A');
      };
      const fnB = () => {
        callsB++;
        return Promise.resolve('B');
      };

      const [a, b] = await Promise.all([sf.do('A', fnA), sf.do('B', fnB)]);

      expect(a).toBe('A');
      expect(b).toBe('B');
      expect(callsA).toBe(1);
      expect(callsB).toBe(1);
      expect(sf.size()).toBe(0);
    });

    it('rejects all waiters when fn rejects, clears entry, next call invokes fresh fn', async () => {
      const sf = new Singleflight<string>();
      let calls = 0;
      const failingFn = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('boom');
      };

      const waiters = Array.from({ length: 5 }, () =>
        sf.do('k', failingFn).catch((e: Error) => e.message),
      );
      const results = await Promise.all(waiters);

      expect(results).toEqual(['boom', 'boom', 'boom', 'boom', 'boom']);
      expect(calls).toBe(1);
      expect(sf.size()).toBe(0);

      const okFn = () => Promise.resolve('recovered');
      const next = await sf.do('k', okFn);
      expect(next).toBe('recovered');
    });

    it('times out after configured timeoutMs and clears the entry', async () => {
      const sf = new Singleflight<string>({ timeoutMs: 100 });
      const hangForever = () => new Promise<string>(() => {});

      const start = Date.now();
      await expect(sf.do('k', hangForever)).rejects.toThrow(
        /singleflight: timed out after 100ms/,
      );
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(400);
      expect(sf.size()).toBe(0);
    });

    it('sequential callers always invoke fn (no historical caching)', async () => {
      const sf = new Singleflight<number>();
      let calls = 0;
      const fn = () => {
        calls++;
        return Promise.resolve(calls);
      };

      const first = await sf.do('k', fn);
      const second = await sf.do('k', fn);
      const third = await sf.do('k', fn);

      expect(first).toBe(1);
      expect(second).toBe(2);
      expect(third).toBe(3);
      expect(calls).toBe(3);
    });
  });
});
