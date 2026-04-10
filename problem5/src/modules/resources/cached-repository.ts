import type Redis from 'ioredis';
import type pino from 'pino';

import type { Resource } from '../../db/schema.js';
import { Singleflight } from '../../cache/singleflight.js';

import type { ResourceRepository, ListResult } from './repository.js';
import type { CreateResourceInput, UpdateResourceInput, ListResourcesQuery } from './schema.js';
import type { RequestContext } from './request-context.js';
import { detailKey, listKey, listVersionKey } from './cache-keys.js';

export interface CachedRepositoryOptions {
  redis: Redis;
  inner: ResourceRepository;
  logger: pino.Logger;
  detailTtlSeconds: number;
  listTtlSeconds: number;
  listVersionKeyPrefix: string;
}

interface SerializedListEntry {
  data: SerializedResource[];
  nextCursor: ListResult['nextCursor'];
}

type SerializedResource = Omit<Resource, 'created_at' | 'updated_at'> & {
  created_at: string;
  updated_at: string;
};

function serializeResource(r: Resource): SerializedResource {
  return {
    ...r,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function deserializeResource(s: SerializedResource): Resource {
  return {
    ...s,
    created_at: new Date(s.created_at),
    updated_at: new Date(s.updated_at),
  };
}

/**
 * Cache-aside decorator over `ResourceRepository`.
 *
 * Read path: check Redis → hit returns, miss falls through singleflighted to
 * the inner repo → result is cached with TTL → returned.
 *
 * Write path: inner repo commits first (source of truth), then we INCR the list
 * version and DEL the affected detail key. Invalidation failures are logged
 * at warn and swallowed; TTLs bound the staleness window.
 *
 * All Redis ops are wrapped in try/catch. Redis outage degrades this layer to
 * a pass-through and never breaks the service.
 */
export class CachedResourceRepository implements ResourceRepository {
  private readonly redis: Redis;
  private readonly inner: ResourceRepository;
  private readonly logger: pino.Logger;
  private readonly detailTtlSeconds: number;
  private readonly listTtlSeconds: number;
  private readonly listVersionKeyPrefix: string;
  private readonly detailSingleflight = new Singleflight<Resource | null>();
  private readonly listSingleflight = new Singleflight<ListResult>();

  constructor(opts: CachedRepositoryOptions) {
    this.redis = opts.redis;
    this.inner = opts.inner;
    this.logger = opts.logger;
    this.detailTtlSeconds = opts.detailTtlSeconds;
    this.listTtlSeconds = opts.listTtlSeconds;
    this.listVersionKeyPrefix = opts.listVersionKeyPrefix;
  }

  async create(input: CreateResourceInput, ctx?: RequestContext): Promise<Resource> {
    const created = await this.inner.create(input, ctx);
    await this.bumpListVersion();
    return created;
  }

  async findById(id: string, ctx?: RequestContext): Promise<Resource | null> {
    const key = detailKey(id);

    const cached = await this.tryGet(key);
    if (cached !== undefined) {
      if (ctx) ctx.cacheStatus = 'HIT';
      if (cached === null) return null;
      return deserializeResource(JSON.parse(cached) as SerializedResource);
    }

    if (ctx) ctx.cacheStatus = 'MISS';

    const result = await this.detailSingleflight.do(key, async () => {
      const row = await this.inner.findById(id, ctx);
      if (row) {
        await this.trySet(key, JSON.stringify(serializeResource(row)), this.detailTtlSeconds);
      }
      return row;
    });

    return result;
  }

  async list(query: ListResourcesQuery, ctx?: RequestContext): Promise<ListResult> {
    const version = await this.readListVersion();
    const key = listKey(query, version);

    const cached = await this.tryGet(key);
    if (cached !== undefined && cached !== null) {
      if (ctx) ctx.cacheStatus = 'HIT';
      const parsed = JSON.parse(cached) as SerializedListEntry;
      return {
        data: parsed.data.map(deserializeResource),
        nextCursor: parsed.nextCursor,
      };
    }

    if (ctx) ctx.cacheStatus = 'MISS';

    const result = await this.listSingleflight.do(key, async () => {
      const fresh = await this.inner.list(query, ctx);
      const serialized: SerializedListEntry = {
        data: fresh.data.map(serializeResource),
        nextCursor: fresh.nextCursor,
      };
      await this.trySet(key, JSON.stringify(serialized), this.listTtlSeconds);
      return fresh;
    });

    return result;
  }

  async update(
    id: string,
    input: UpdateResourceInput,
    ctx?: RequestContext,
  ): Promise<Resource | null> {
    const updated = await this.inner.update(id, input, ctx);
    if (updated) {
      await this.tryDel(detailKey(id));
      await this.bumpListVersion();
    }
    return updated;
  }

  async delete(id: string, ctx?: RequestContext): Promise<boolean> {
    const deleted = await this.inner.delete(id, ctx);
    if (deleted) {
      await this.tryDel(detailKey(id));
      await this.bumpListVersion();
    }
    return deleted;
  }

  // --- Redis wrappers (swallow errors, log at warn) -----------------------

  /**
   * Returns the cached string, `null` if key exists with a null marker,
   * or `undefined` on miss or Redis failure.
   */
  private async tryGet(key: string): Promise<string | null | undefined> {
    try {
      const value = await this.redis.get(key);
      if (value === null) return undefined;
      return value;
    } catch (err) {
      this.logger.warn({ err: String(err), key }, 'cache GET failed');
      return undefined;
    }
  }

  private async trySet(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn({ err: String(err), key }, 'cache SET failed');
    }
  }

  private async tryDel(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn({ err: String(err), key }, 'cache DEL failed');
    }
  }

  private async readListVersion(): Promise<number> {
    try {
      const raw = await this.redis.get(listVersionKey(this.listVersionKeyPrefix));
      if (raw === null) return 1;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 1;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'cache list-version GET failed');
      return 1;
    }
  }

  private async bumpListVersion(): Promise<void> {
    try {
      await this.redis.incr(listVersionKey(this.listVersionKeyPrefix));
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'cache list-version INCR failed');
    }
  }
}
