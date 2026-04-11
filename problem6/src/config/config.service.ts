import { Injectable } from '@nestjs/common';

import type { Config } from './schema';

@Injectable()
export class ConfigService {
  private readonly config: Readonly<Config>;

  constructor(config: Config) {
    this.config = Object.freeze({ ...config });
  }

  get<K extends keyof Config>(key: K): Config[K] {
    return this.config[key];
  }
}
