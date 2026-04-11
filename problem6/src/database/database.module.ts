import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';

import { ConfigService } from '../config';

import { buildDatabase, type Database } from './database.factory';

export const DATABASE = 'Database';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (config: ConfigService): Database => buildDatabase(config),
      inject: [ConfigService],
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
