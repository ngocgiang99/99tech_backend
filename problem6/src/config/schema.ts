import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  NATS_URL: z.string().min(1),
  NATS_STREAM_NAME: z.string().min(1).default('SCOREBOARD'),
  NATS_STREAM_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2592000),
  NATS_STREAM_MAX_MSGS: z.coerce.number().int().positive().default(1000000),
  NATS_STREAM_MAX_BYTES: z.coerce.number().int().positive().default(1073741824),
  NATS_STREAM_REPLICAS: z.coerce.number().int().positive().default(1),
  NATS_DEDUP_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),

  INTERNAL_JWT_SECRET: z.string().min(32),
  ACTION_TOKEN_SECRET: z.string().min(32),
  ACTION_TOKEN_SECRET_PREV: z.string().min(32).optional(),
  ACTION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(10),
  MAX_SSE_CONN_PER_INSTANCE: z.coerce.number().int().positive().default(5000),
  LEADERBOARD_REBUILD_TOP_N: z.coerce.number().int().positive().default(10000),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type Config = z.infer<typeof EnvSchema>;
