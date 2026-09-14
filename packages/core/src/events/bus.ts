import type { AnyDomainEvent, EventType } from './types';

export interface EventFilter {
  types?: readonly EventType[];
  projectId?: string;
}

export type EventHandler = (event: AnyDomainEvent) => void | Promise<void>;

/**
 * In-process typed event bus. Persistence happens before publish (see EventRecorder port), so a
 * handler failure never loses an event; handler errors are isolated and reported.
 */
export class EventBus {
  private readonly subscribers = new Set<{ handler: EventHandler; filter: EventFilter }>();

  constructor(private readonly onHandlerError: (error: unknown, event: AnyDomainEvent) => void = () => {}) {}

  subscribe(handler: EventHandler, filter: EventFilter = {}): () => void {
    const entry = { handler, filter };
    this.subscribers.add(entry);
    return () => this.subscribers.delete(entry);
  }

  publish(event: AnyDomainEvent): void {
    for (const { handler, filter } of this.subscribers) {
      if (filter.types && !filter.types.includes(event.type)) continue;
      if (filter.projectId && event.projectId !== filter.projectId) continue;
      try {
        const result = handler(event);
        if (result instanceof Promise) result.catch((error: unknown) => this.onHandlerError(error, event));
      } catch (error) {
        this.onHandlerError(error, event);
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
