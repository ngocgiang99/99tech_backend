import { Global, Module } from '@nestjs/common';
import { ZodError } from 'zod';

import { ConfigService } from './config.service';
import { EnvSchema } from './schema';

function loadConfig(): ConfigService {
  try {
    const parsed = EnvSchema.parse(process.env);
    return new ConfigService(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((issue) => {
        const path = issue.path.join('.') || '(root)';
        return `  - ${path}: ${issue.message}`;
      });
      console.error(
        `[config] Environment validation failed:\n${lines.join('\n')}`,
      );
    } else {
      console.error('[config] Unexpected error while parsing environment:', err);
    }
    process.exit(1);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useFactory: loadConfig,
    },
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
