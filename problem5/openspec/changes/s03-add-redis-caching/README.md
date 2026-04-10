# s03-add-redis-caching

Cache-aside layer wrapping ResourceRepository: detail TTL 5min, list keyed on filters + version counter, singleflight on miss
