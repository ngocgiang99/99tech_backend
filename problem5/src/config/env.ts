import 'dotenv/config';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CACHE_DETAIL_TTL_SECONDS: z.coerce.number().int().min(1).default(300),
  CACHE_LIST_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  CACHE_LIST_VERSION_KEY_PREFIX: z.string().min(1).default('resource:list:version'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10000),
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  METRICS_DEFAULT_METRICS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    process.stderr.write(
      `[config] Failed to load environment configuration:\n${formatted}\n`,
    );
    process.exit(1);
  }

  return result.data;
}
