import { RedisModule } from '../../../src/scoreboard/infrastructure/persistence/redis/redis.module';
import { NatsModule } from '../../../src/scoreboard/infrastructure/messaging/nats/nats.module';

describe('RedisModule#onApplicationShutdown', () => {
  it('calls redis.quit() once on the first shutdown, no-ops on the second', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const redis = { quit } as unknown as import('ioredis').Redis;
    const mod = new RedisModule(redis);

    await mod.onApplicationShutdown('SIGTERM');
    await mod.onApplicationShutdown('SIGTERM');

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from redis.quit() and does not throw', async () => {
    const quit = jest.fn().mockRejectedValue(new Error('already closed'));
    const redis = { quit } as unknown as import('ioredis').Redis;
    const mod = new RedisModule(redis);

    await expect(mod.onApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
  });
});

describe('NatsModule#onApplicationShutdown', () => {
  it('calls drain() then close() once on first shutdown', async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn().mockResolvedValue(undefined);
    const nc = { drain, close } as unknown as import('nats').NatsConnection;
    const mod = new NatsModule(nc);

    await mod.onApplicationShutdown('SIGTERM');

    expect(drain).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on second call', async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn().mockResolvedValue(undefined);
    const nc = { drain, close } as unknown as import('nats').NatsConnection;
    const mod = new NatsModule(nc);

    await mod.onApplicationShutdown('SIGTERM');
    await mod.onApplicationShutdown('SIGTERM');

    expect(drain).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('swallows drain errors (already-draining) and still attempts close', async () => {
    const drain = jest.fn().mockRejectedValue(new Error('already draining'));
    const close = jest.fn().mockResolvedValue(undefined);
    const nc = { drain, close } as unknown as import('nats').NatsConnection;
    const mod = new NatsModule(nc);

    await expect(mod.onApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
