import type { AnyDomainEvent } from '@orch/core';

// Multi-instance event fan-out (ADR-024). Events are persisted first (ADR-008); the NOTIFY payload carries only
// the event id, listeners load the row and publish it on their local bus. Ids are deduplicated so the emitting
// instance (which already published locally) and repeated notifications never deliver an event twice.

export const EVENT_CHANNEL = 'orch_events';

export interface EventFanout {
  readonly kind: 'local' | 'pg-notify';
  /** Called after an event was persisted and published locally. */
  announce(event: AnyDomainEvent): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Single process (PGlite, or fan-out disabled): the in-process bus already reaches every subscriber. */
export class LocalEventFanout implements EventFanout {
  readonly kind = 'local' as const;
  async announce(): Promise<void> {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Bounded set of recently seen ids; the oldest entries are evicted first. */
export class RecentIdSet {
  private readonly ids = new Set<number>();

  constructor(private readonly capacity = 10_000) {}

  /** Returns false when the id was already present. */
  add(id: number): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  has(id: number): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}

export interface EventRelayDeps {
  /** Loads persisted events with id > afterId in ascending order. */
  loadAfter(afterId: number, limit: number): Promise<AnyDomainEvent[]>;
  publish(event: AnyDomainEvent): void;
  onResult?(result: 'published' | 'duplicate' | 'invalid' | 'missing' | 'replayed'): void;
}

export const MAX_REPLAY = 500;

/** Pure relay logic, independent of the PostgreSQL client so it can be tested with fakes. */
export class EventRelay {
  private readonly seen: RecentIdSet;
  private highestId = 0;

  constructor(
    private readonly deps: EventRelayDeps,
    capacity = 10_000,
  ) {
    this.seen = new RecentIdSet(capacity);
  }

  private track(id: number): boolean {
    if (id > this.highestId) this.highestId = id;
    return this.seen.add(id);
  }

  /** The local instance published this event itself; its own notification must be ignored. */
  markLocal(event: AnyDomainEvent): number | null {
    const id = Number(event.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    this.track(id);
    return id;
  }

  async onNotification(payload: string | undefined): Promise<void> {
    if (!payload || !/^[1-9][0-9]{0,15}$/.test(payload)) return this.deps.onResult?.('invalid');
    const id = Number(payload);
    if (this.seen.has(id)) return this.deps.onResult?.('duplicate');
    const [event] = await this.deps.loadAfter(id - 1, 1);
    if (!event || Number(event.id) !== id) return this.deps.onResult?.('missing');
    // Another concurrent notification may have delivered it while the row was loading.
    if (!this.track(id)) return this.deps.onResult?.('duplicate');
    this.deps.publish(event);
    this.deps.onResult?.('published');
  }

  /**
   * After the listener (re)connects, notifications sent while it was disconnected are lost: replay persisted
   * events newer than the highest id this instance has seen (bounded).
   */
  async replayMissed(): Promise<number> {
    if (this.highestId === 0) return 0;
    let replayed = 0;
    for (const event of await this.deps.loadAfter(this.highestId, MAX_REPLAY)) {
      if (!this.track(Number(event.id))) continue;
      this.deps.publish(event);
      this.deps.onResult?.('replayed');
      replayed++;
    }
    return replayed;
  }
}

export interface NotifyConnection {
  listen(channel: string, onPayload: (payload: string | undefined) => void, onError: (error: unknown) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
}

export interface PgNotifyFanoutOptions {
  connection: NotifyConnection;
  relay: EventRelay;
  log?: { warn(details: object, message?: string): void; error(details: object, message?: string): void };
  /** Delay before reconnecting a lost listener; doubles up to 30 s. */
  reconnectDelayMs?: number;
}

/** PostgreSQL LISTEN/NOTIFY fan-out with reconnect and gap replay. */
export class PgNotifyEventFanout implements EventFanout {
  readonly kind = 'pg-notify' as const;
  private unlisten: (() => Promise<void>) | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(private readonly options: PgNotifyFanoutOptions) {}

  async announce(event: AnyDomainEvent): Promise<void> {
    const id = this.options.relay.markLocal(event);
    if (id === null) return;
    try {
      await this.options.connection.notify(EVENT_CHANNEL, String(id));
    } catch (error) {
      // The event is persisted; other instances' SSE clients still get it through Last-Event-ID replay.
      this.options.log?.warn({ err: error, eventId: id }, 'event notify failed');
    }
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      this.unlisten = await this.options.connection.listen(
        EVENT_CHANNEL,
        (payload) => void this.options.relay.onNotification(payload).catch((error: unknown) => this.options.log?.error({ err: error }, 'event relay failed')),
        (error) => this.scheduleReconnect(error),
      );
      this.failures = 0;
      await this.options.relay.replayMissed();
    } catch (error) {
      this.scheduleReconnect(error);
    }
  }

  private scheduleReconnect(error: unknown): void {
    if (this.closed || this.reconnectTimer) return;
    this.options.log?.warn({ err: error }, 'event listener lost; reconnecting');
    const unlisten = this.unlisten;
    this.unlisten = null;
    void unlisten?.().catch(() => {});
    const base = this.options.reconnectDelayMs ?? 1_000;
    const delay = Math.min(30_000, base * 2 ** Math.min(this.failures, 5));
    this.failures++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const unlisten = this.unlisten;
    this.unlisten = null;
    await unlisten?.();
  }
}
