'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EVENT_TYPES, type DomainEvent } from '@/lib/types';

export type LiveState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'offline';

interface LiveEventsValue {
  events: DomainEvent[];
  state: LiveState;
  subscribe(listener: (event: DomainEvent) => void): () => void;
}

const MAX_EVENTS = 150;

const LiveEventsContext = createContext<LiveEventsValue>({
  events: [],
  state: 'idle',
  subscribe: () => () => undefined,
});

/**
 * One shared EventSource for the whole app. Components subscribe for callbacks (refetch) or read the
 * rolling buffer of recent events (feeds).
 */
export function LiveEventsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [events, setEvents] = useState<DomainEvent[]>([]);
  const [state, setState] = useState<LiveState>('idle');
  const listeners = useRef(new Set<(event: DomainEvent) => void>());
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setState('idle');
      return;
    }
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const handle = (message: MessageEvent<string>) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(message.data) as DomainEvent;
      } catch {
        return;
      }
      const key = event.id ?? message.lastEventId;
      if (key) {
        if (seen.current.has(key)) return;
        seen.current.add(key);
        if (seen.current.size > 2000) seen.current = new Set([...seen.current].slice(-1000));
      }
      setEvents((previous) => [event, ...previous].slice(0, MAX_EVENTS));
      for (const listener of listeners.current) listener(event);
    };

    const connect = () => {
      if (disposed) return;
      setState((previous) => (previous === 'open' || previous === 'reconnecting' ? 'reconnecting' : 'connecting'));
      source = new EventSource('/api/events/stream');
      source.onopen = () => setState('open');
      source.onerror = () => {
        if (!source) return;
        if (source.readyState === EventSource.CLOSED) {
          // The browser gave up (e.g. non-200 response); retry ourselves with a back-off.
          setState('offline');
          source.close();
          retryTimer = setTimeout(connect, 5000);
        } else {
          setState('reconnecting');
        }
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
      source.onmessage = handle;
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled]);

  const subscribe = useCallback((listener: (event: DomainEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo(() => ({ events, state, subscribe }), [events, state, subscribe]);
  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
}

export function useLiveEvents(filter?: (event: DomainEvent) => boolean): { events: DomainEvent[]; state: LiveState } {
  const { events, state } = useContext(LiveEventsContext);
  const filtered = useMemo(() => (filter ? events.filter(filter) : events), [events, filter]);
  return { events: filtered, state };
}

/** Calls `onEvent` (debounced) whenever a matching live event arrives. */
export function useLiveRefresh(match: ((event: DomainEvent) => boolean) | null | undefined, onEvent: () => void, delayMs = 500): void {
  const { subscribe } = useContext(LiveEventsContext);
  const matchRef = useRef(match);
  const callbackRef = useRef(onEvent);
  useEffect(() => {
    matchRef.current = match;
    callbackRef.current = onEvent;
  });
  const enabled = Boolean(match);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event) => {
      if (!matchRef.current?.(event)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => callbackRef.current(), delayMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, subscribe, delayMs]);
}
