import { describe, expect, it } from 'vitest';
import type { AnyDomainEvent } from '@orch/core';
import { EVENT_CHANNEL, EventRelay, LocalEventFanout, MAX_REPLAY, PgNotifyEventFanout, RecentIdSet, type NotifyConnection } from './event-fanout';

function event(id: number, projectId = 'prj_a'): AnyDomainEvent {
  return { id: String(id), type: 'task.created', projectId, taskId: null, runId: null, payload: { title: `t${id}` }, createdAt: new Date() } as AnyDomainEvent;
}

function fakeStore(ids: number[]) {
  const rows = ids.map((id) => event(id));
  const loads: Array<{ afterId: number; limit: number }> = [];
  return {
    rows,
    loads,
    loadAfter: async (afterId: number, limit: number) => {
      loads.push({ afterId, limit });
      return rows.filter((r) => Number(r.id) > afterId).slice(0, limit);
    },
  };
}

describe('RecentIdSet', () => {
  it('deduplicates and evicts the oldest ids beyond its capacity', () => {
    const set = new RecentIdSet(3);
    expect(set.add(1)).toBe(true);
    expect(set.add(1)).toBe(false);
    set.add(2);
    set.add(3);
    set.add(4);
    expect(set.size).toBe(3);
    expect(set.has(1)).toBe(false);
    expect(set.has(4)).toBe(true);
  });
});

describe('EventRelay', () => {
  it('loads notified events by id and publishes each exactly once', async () => {
    const store = fakeStore([1, 2, 3]);
    const published: string[] = [];
    const results: string[] = [];
    const relay = new EventRelay({ loadAfter: store.loadAfter, publish: (e) => published.push(String(e.id)), onResult: (r) => results.push(r) });

    await relay.onNotification('2');
    await relay.onNotification('2');
    await Promise.all([relay.onNotification('3'), relay.onNotification('3')]);

    expect(published).toEqual(['2', '3']);
    expect(store.loads[0]).toEqual({ afterId: 1, limit: 1 });
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(2);
  });

  it('ignores events this instance published itself', async () => {
    const store = fakeStore([7]);
    const published: AnyDomainEvent[] = [];
    const relay = new EventRelay({ loadAfter: store.loadAfter, publish: (e) => published.push(e) });
    expect(relay.markLocal(event(7))).toBe(7);
    await relay.onNotification('7');
    expect(published).toHaveLength(0);
    expect(store.loads).toHaveLength(0);
  });

  it('rejects malformed payloads and tolerates rows that no longer exist', async () => {
    const store = fakeStore([5]);
    const results: string[] = [];
    const relay = new EventRelay({ loadAfter: store.loadAfter, publish: () => {}, onResult: (r) => results.push(r) });
    for (const payload of [undefined, '', 'abc', '-1', '0', '1; drop table events', '99999999999999999999']) await relay.onNotification(payload);
    await relay.onNotification('4'); // id 4 is missing; loadAfter(3) returns id 5, which must not be published as 4
    expect(results).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'missing']);
    expect(relay.markLocal({ ...event(1), id: 'not-a-number' } as AnyDomainEvent)).toBeNull();
  });

  it('replays events missed while disconnected, bounded and without duplicates', async () => {
    const store = fakeStore([1, 2, 3, 4, 5]);
    const published: string[] = [];
    const relay = new EventRelay({ loadAfter: store.loadAfter, publish: (e) => published.push(String(e.id)) });
    expect(await relay.replayMissed()).toBe(0); // nothing seen yet: live notifications only
    relay.markLocal(event(2));
    await relay.onNotification('4');
    expect(await relay.replayMissed()).toBe(1);
    expect(published).toEqual(['4', '5']);
    expect(store.loads.at(-1)).toEqual({ afterId: 4, limit: MAX_REPLAY });
  });
});

class FakeConnection implements NotifyConnection {
  notified: Array<{ channel: string; payload: string }> = [];
  listens = 0;
  unlistens = 0;
  failNextListen = false;
  onPayload: ((payload: string | undefined) => void) | null = null;
  onError: ((error: unknown) => void) | null = null;

  async listen(channel: string, onPayload: (payload: string | undefined) => void, onError: (error: unknown) => void) {
    expect(channel).toBe(EVENT_CHANNEL);
    this.listens++;
    if (this.failNextListen) {
      this.failNextListen = false;
      throw new Error('connection refused');
    }
    this.onPayload = onPayload;
    this.onError = onError;
    return async () => {
      this.unlistens++;
    };
  }

  async notify(channel: string, payload: string) {
    this.notified.push({ channel, payload });
  }
}

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('PgNotifyEventFanout', () => {
  it('notifies with the event id only and drops its own echo', async () => {
    const store = fakeStore([10, 11]);
    const published: string[] = [];
    const connection = new FakeConnection();
    const fanout = new PgNotifyEventFanout({ connection, relay: new EventRelay({ loadAfter: store.loadAfter, publish: (e) => published.push(String(e.id)) }) });
    await fanout.start();

    await fanout.announce(event(10));
    expect(connection.notified).toEqual([{ channel: EVENT_CHANNEL, payload: '10' }]);
    connection.onPayload!('10');
    connection.onPayload!('11');
    await waitFor(() => published.length === 1);
    expect(published).toEqual(['11']);
    await fanout.close();
    expect(connection.unlistens).toBe(1);
  });

  it('reconnects after a lost connection and replays the gap', async () => {
    const store = fakeStore([1, 2, 3]);
    const published: string[] = [];
    const connection = new FakeConnection();
    const warnings: string[] = [];
    const fanout = new PgNotifyEventFanout({
      connection,
      relay: new EventRelay({ loadAfter: store.loadAfter, publish: (e) => published.push(String(e.id)) }),
      reconnectDelayMs: 1,
      log: { warn: (_d, message) => warnings.push(message ?? ''), error: () => {} },
    });
    connection.failNextListen = true;
    await fanout.start(); // first attempt fails, retried in the background
    await waitFor(() => connection.listens === 2);

    connection.onPayload!('1');
    await waitFor(() => published.length === 1);
    connection.onError!(new Error('terminated'));
    connection.onError!(new Error('terminated twice')); // a second error while reconnecting is coalesced
    await waitFor(() => connection.listens === 3);
    await waitFor(() => published.length === 3);
    expect(published).toEqual(['1', '2', '3']);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    await fanout.close();
  });

  it('local fan-out is a no-op for single-process databases', async () => {
    const local = new LocalEventFanout();
    await local.start();
    await local.announce();
    await local.close();
    expect(local.kind).toBe('local');
  });
});
