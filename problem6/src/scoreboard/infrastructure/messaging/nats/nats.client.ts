import { connect } from 'nats';
import type { NatsConnection } from 'nats';

import { ConfigService } from '../../../../config';

export async function buildNatsClient(
  config: ConfigService,
): Promise<NatsConnection> {
  return connect({ servers: config.get('NATS_URL') });
}
