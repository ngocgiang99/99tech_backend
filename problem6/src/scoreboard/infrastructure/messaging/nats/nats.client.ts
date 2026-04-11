import { connect } from 'nats';
import type { NatsConnection } from 'nats';

import { ConfigService } from '../../../../config';

export async function buildNatsClient(
  config: ConfigService,
): Promise<NatsConnection> {
  const rawUrl = config.get('NATS_URL');
  const parsed = new URL(rawUrl);
  return connect({
    servers: `${parsed.hostname}:${parsed.port || 4222}`,
    ...(parsed.username ? { user: parsed.username } : {}),
    ...(parsed.password ? { pass: parsed.password } : {}),
  });
}
