export interface DomainEvent {
  subject: string;
  payload: Record<string, unknown>;
}

export interface DomainEventPublisher {
  publish(event: DomainEvent, options: { msgId: string }): Promise<void>;
}

export const DOMAIN_EVENT_PUBLISHER = Symbol('DomainEventPublisher');
