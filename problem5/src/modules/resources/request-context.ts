/**
 * Per-request mutable bag for cross-layer signals that should not be baked
 * into return types. The controller creates one, passes it to the service,
 * and reads it back after the call to extract cache observability flags.
 */
export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export interface RequestContext {
  cacheStatus?: CacheStatus;
}

export function createRequestContext(): RequestContext {
  return {};
}
