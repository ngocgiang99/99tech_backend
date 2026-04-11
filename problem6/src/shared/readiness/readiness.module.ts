import { Global, Module } from '@nestjs/common';

import { ReadinessService } from './readiness.service';

@Global()
@Module({
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class ReadinessModule {}
