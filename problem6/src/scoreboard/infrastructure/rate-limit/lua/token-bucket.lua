-- Token Bucket Rate Limiter
-- KEYS[1]  = bucket hash key (e.g. "rate:user:<userId>")
-- ARGV[1]  = capacity (max burst tokens, integer)
-- ARGV[2]  = refill rate (tokens per second, integer)
-- ARGV[3]  = now (unix timestamp in milliseconds)
--
-- Returns:
--   {1, remaining_tokens}      on success (request admitted)
--   {0, ms_until_next_token}   on reject  (bucket empty)

local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])   -- tokens per second
local now      = tonumber(ARGV[3])   -- milliseconds

-- Read existing state
local tokens_raw    = redis.call('HGET', key, 'tokens')
local last_refill   = tonumber(redis.call('HGET', key, 'last_refill'))

local tokens

if tokens_raw == false or last_refill == nil then
    -- First call: initialise at full capacity
    tokens      = capacity
    last_refill = now
else
    -- Refill based on elapsed time
    tokens = tonumber(tokens_raw)
    local elapsed_ms     = now - last_refill
    local tokens_to_add  = math.floor(elapsed_ms * rate / 1000)
    if tokens_to_add > 0 then
        tokens      = math.min(capacity, tokens + tokens_to_add)
        last_refill = now
    end
end

-- TTL in seconds: keep key alive for 2 * capacity / rate seconds
local ttl_seconds = math.ceil(2 * capacity / rate)

if tokens >= 1 then
    -- Admit: decrement and persist
    tokens = tokens - 1
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
    redis.call('EXPIRE', key, ttl_seconds)
    return {1, tokens}
else
    -- Reject: calculate wait time until next token arrives
    -- At rate tokens/sec, 1 token arrives every (1000/rate) ms
    local ms_per_token    = math.ceil(1000 / rate)
    local ms_until_next   = ms_per_token - ((now - last_refill) % ms_per_token)
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
    redis.call('EXPIRE', key, ttl_seconds)
    return {0, ms_until_next}
end
