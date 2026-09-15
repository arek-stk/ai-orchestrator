'use client';

import { RotateCcw, SearchX, TriangleAlert } from 'lucide-react';
import { Skeleton } from '../ui';

export function HubEmptyState({ query, onReset }: { query: string; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-hub-line-strong bg-hub-card px-6 py-14 text-center">
      <span aria-hidden="true" className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-hub-line bg-hub-card-2 text-ink-2">
        <SearchX size={20} />
      </span>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">Keine passende KI gefunden</h3>
      <p className="mt-1 max-w-sm text-[13px] text-ink-2">
        {query.trim() ? `Für „${query.trim()}“ gibt es mit den aktuellen Filtern keine Treffer.` : 'Mit dieser Kombination aus Kategorie und Filtern gibt es keine Treffer.'}
      </p>
      <button
        type="button"
        onClick={onReset}
        className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-xl bg-hub-cta px-4 text-[13px] font-medium text-white transition-[background-color] duration-150 ease-out hover:bg-hub-cta-hover"
      >
        <RotateCcw aria-hidden="true" size={14} />
        Filter zurücksetzen
      </button>
    </div>
  );
}

export function HubErrorState({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border border-hub-line bg-hub-card px-6 py-14 text-center">
      <span aria-hidden="true" className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-critical-soft text-critical">
        <TriangleAlert size={20} />
      </span>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">Der AI Hub konnte nicht geladen werden</h3>
      <p className="mt-1 max-w-md break-words text-[13px] text-ink-2">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-xl border border-hub-line-strong px-4 text-[13px] font-medium text-ink transition-[background-color] duration-150 ease-out hover:bg-hub-card-2 disabled:opacity-60"
      >
        <RotateCcw aria-hidden="true" size={14} className={busy ? 'animate-spin' : undefined} />
        Erneut versuchen
      </button>
    </div>
  );
}

export function HubCardSkeletons({ count = 8 }: { count?: number }) {
  return (
    <div className="@container" role="status">
      <span className="sr-only">KI-Tools werden geladen …</span>
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
        {Array.from({ length: count }).map((_, index) => (
          <div key={index} aria-hidden="true" className="flex h-[292px] flex-col rounded-[18px] border border-hub-line bg-hub-card p-4">
            <Skeleton className="h-11 w-11 rounded-xl" />
            <Skeleton className="mt-4 h-4 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/3" />
            <Skeleton className="mt-3 h-6 w-24 rounded-full" />
            <Skeleton className="mt-4 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-4/5" />
            <Skeleton className="mt-auto h-10 w-full rounded-[10px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Full-page placeholder while the route's client bundle and search params resolve. */
export function HubSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-5">
      <span className="sr-only">AI Hub wird geladen …</span>
      <div aria-hidden="true" className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72 max-w-[60vw]" />
        </div>
      </div>
      <Skeleton className="h-[220px] rounded-3xl" />
      <div aria-hidden="true" className="flex gap-2 overflow-hidden">
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-11 rounded-xl" />
      <HubCardSkeletons count={4} />
    </div>
  );
}
