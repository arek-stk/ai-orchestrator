'use client';

import { ArrowDownUp, ChevronDown } from 'lucide-react';
import { useId } from 'react';
import { SORT_LABELS, SORT_OPTIONS, type SortOption } from '@/lib/hub/types';

/** Native select for robust keyboard and screen reader support, styled like the other toolbar controls. */
export function SortSelect({ value, onChange }: { value: SortOption; onChange: (value: SortOption) => void }) {
  const id = useId();
  return (
    <div className="relative shrink-0">
      <label htmlFor={id} className="sr-only">
        Sortieren nach
      </label>
      <ArrowDownUp aria-hidden="true" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2 sm:hidden" />
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as SortOption)}
        className="h-11 w-11 cursor-pointer appearance-none rounded-xl border border-hub-line bg-hub-card text-[13px] text-transparent shadow-hub-card transition-[border-color] duration-150 ease-out hover:border-hub-line-strong focus-visible:border-hub-cta sm:w-auto sm:pl-3.5 sm:pr-9 sm:text-ink [&>option]:text-ink"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {SORT_LABELS[option]}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" size={15} className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 text-ink-2 sm:block" />
    </div>
  );
}
