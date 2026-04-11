import { RedisTokenBucket } from '../../../src/scoreboard/infrastructure/rate-limit/redis-token-bucket';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedis(evalshaImpl: jest.Mock) {
  return {
    script: jest.fn().mockResolvedValue('mock-sha'),
    evalsha: evalshaImpl,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisTokenBucket', () => {
  let bucket: RedisTokenBucket;

  describe('bucket admit', () => {
    it('returns allowed: true when Lua returns [1, remaining]', async () => {
      const evalsha = jest.fn().mockResolvedValue([1, 15]);
      const redis = makeRedis(evalsha);
      bucket = new RedisTokenBucket(redis as never);
      await bucket.onModuleInit();

      const result = await bucket.consume('user-1', 20, 10);

      expect(result).toEqual({ allowed: true });
      expect(evalsha).toHaveBeenCalledWith('mock-sha', 1, 'rate:user:user-1', 20, 10, expect.any(Number));
    });
  });

  describe('bucket reject', () => {
    it('returns allowed: false with retryAfterMs when Lua returns [0, ms]', async () => {
      const evalsha = jest.fn().mockResolvedValue([0, 250]);
      const redis = makeRedis(evalsha);
      bucket = new RedisTokenBucket(redis as never);
      await bucket.onModuleInit();

      const result = await bucket.consume('user-2', 20, 10);

      expect(result).toEqual({ allowed: false, retryAfterMs: 250 });
    });
  });

  describe('NOSCRIPT recovery', () => {
    it('reloads the script and retries on NOSCRIPT error', async () => {
      const noscriptError = new Error('NOSCRIPT No matching script');
      const evalsha = jest
        .fn()
        .mockRejectedValueOnce(noscriptError)
        .mockResolvedValue([1, 19]);

      const scriptMock = jest
        .fn()
        .mockResolvedValueOnce('sha-initial')
        .mockResolvedValueOnce('sha-reloaded');

      const redis = {
        script: scriptMock,
        evalsha,
      };

      bucket = new RedisTokenBucket(redis as never);
      await bucket.onModuleInit(); // script('LOAD', ...) → 'sha-initial'

      const result = await bucket.consume('user-3', 20, 10);

      // Should have re-loaded with new sha and retried
      expect(scriptMock).toHaveBeenCalledTimes(2);
      expect(evalsha).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ allowed: true });
    });

    it('propagates non-NOSCRIPT errors', async () => {
      const connectionError = new Error('Connection refused');
      const evalsha = jest.fn().mockRejectedValue(connectionError);
      const redis = makeRedis(evalsha);
      bucket = new RedisTokenBucket(redis as never);
      await bucket.onModuleInit();

      await expect(bucket.consume('user-4', 20, 10)).rejects.toThrow('Connection refused');
    });
  });

  describe('onModuleInit', () => {
    it('loads the Lua script and stores the SHA', async () => {
      const evalsha = jest.fn().mockResolvedValue([1, 10]);
      const scriptMock = jest.fn().mockResolvedValue('abc123');
      const redis = { script: scriptMock, evalsha };

      bucket = new RedisTokenBucket(redis as never);
      await bucket.onModuleInit();

      expect(scriptMock).toHaveBeenCalledWith('LOAD', expect.any(String));
    });
  });
});
