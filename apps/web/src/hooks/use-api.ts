'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { DomainEvent } from '@/lib/types';
import { useLiveRefresh } from './use-live-events';

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  /** First load only: no data yet. */
  loading: boolean;
  /** A background refetch is running while previous data stays visible. */
  refreshing: boolean;
  reload: () => Promise<void>;
}

/**
 * GET a JSON resource. Changing `path` keeps the previous data on screen (rendered dimmed by callers via
 * `refreshing`) instead of flashing a skeleton. `live` refetches (debounced) on matching live events.
 */
export function useApi<T>(path: string | null, options: { live?: (event: DomainEvent) => boolean } = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    const current = pathRef.current;
    if (!current) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRefreshing(true);
    try {
      const result = await api<T>(current, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (abort.signal.aborted || (err as Error).name === 'AbortError') return;
      setError(errorMessage(err));
    } finally {
      if (controller.current === abort) {
        setRefreshing(false);
        controller.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!path) return;
    void reload();
    return () => controller.current?.abort();
  }, [path, reload]);

  useLiveRefresh(options.live, () => void reload());

  return { data, error, loading: data === null && error === null && path !== null, refreshing, reload };
}

/** Wraps a mutating call with pending/error state. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <R,>(key: string, fn: () => Promise<R>): Promise<R | undefined> => {
    setPending(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setPending(null);
    }
  }, []);

  return { pending, error, run, clearError: () => setError(null) };
}
