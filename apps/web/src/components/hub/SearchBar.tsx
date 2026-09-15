'use client';

import { Search, X } from 'lucide-react';
import type { Ref } from 'react';

export function SearchBar({ value, onChange, inputRef, shortcutLabel }: { value: string; onChange: (value: string) => void; inputRef?: Ref<HTMLInputElement>; shortcutLabel: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-2" />
      <input
        ref={inputRef}
        type="search"
        id="hub-search"
        name="q"
        value={value}
        maxLength={120}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            onChange('');
          }
        }}
        aria-label="KI suchen"
        aria-keyshortcuts="Meta+K Control+K"
        placeholder="KI suchen …"
        autoComplete="off"
        spellCheck={false}
        className="h-11 w-full min-w-0 rounded-xl border border-hub-line bg-hub-card pl-10 pr-12 text-[14px] text-ink shadow-hub-card transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-ink-2 hover:border-hub-line-strong focus-visible:border-hub-cta focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-hub-cta/20 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value ? (
        <button
          type="button"
          aria-label="Suche leeren"
          onClick={() => onChange('')}
          className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink-2 transition-[color,background-color] duration-150 ease-out hover:bg-hub-card-2 hover:text-ink"
        >
          <X aria-hidden="true" size={15} />
        </button>
      ) : (
        <kbd aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 hidden h-6 -translate-y-1/2 items-center rounded-md border border-hub-line bg-hub-card-2 px-1.5 font-sans text-[11px] text-ink-2 sm:inline-flex">
          {shortcutLabel}
        </kbd>
      )}
    </div>
  );
}
