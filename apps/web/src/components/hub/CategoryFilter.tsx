'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { subcategoriesOf } from '@/lib/hub/filter';
import { CATEGORY_LABELS, HUB_CATEGORIES, type HubCategory } from '@/lib/hub/types';
import { cx } from '../ui';

interface Option {
  id: string;
  label: string;
  count: number;
}

/** Edge fades only on the sides that actually have more pills to scroll to. */
function useScrollFades(ref: React.RefObject<HTMLElement | null>) {
  const [fade, setFade] = useState({ start: false, end: false });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  };
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  });
  // Counts change pill widths, so re-measure after every render (cheap; state only changes when a side flips).
  useEffect(() => updateRef.current());
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => updateRef.current();
    el.addEventListener('scroll', onChange, { passive: true });
    const observer = new ResizeObserver(onChange);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', onChange);
      observer.disconnect();
    };
  }, [ref]);
  return fade;
}

/** Radio group with roving tab index in a single scrollable row: arrow keys and Home/End move the selection. */
function PillGroup({ label, options, active, onSelect, size }: { label: string; options: Option[]; active: string; onSelect: (id: string) => void; size: 'lg' | 'sm' }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fade = useScrollFades(scrollRef);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onSelect(option.id);
    const el = refs.current[next];
    el?.focus();
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div
      ref={scrollRef}
      role="radiogroup"
      aria-label={label}
      data-fade-start={fade.start || undefined}
      data-fade-end={fade.end || undefined}
      className="hub-scroll-x -mx-4 flex min-w-0 scroll-px-10 gap-1.5 overflow-x-auto px-4 py-1 sm:-mx-1 sm:px-1"
    >
      {options.map((option, index) => {
        const selected = option.id === active;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={(event) => {
              onSelect(option.id);
              event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-medium transition-[background-color,border-color,color,box-shadow] duration-150 ease-out after:absolute after:inset-x-0 after:content-['']",
              size === 'lg' ? 'h-9 pl-3 pr-1.5 text-[13px] after:-inset-y-0.5' : 'h-8 pl-3 pr-1.5 text-xs after:-inset-y-1',
              selected
                ? size === 'lg'
                  ? 'border-transparent bg-hub-cta text-white shadow-[0_8px_22px_-12px_var(--hub-cta)]'
                  : 'border-hub-cta bg-hub-card-2 text-ink'
                : 'border-hub-line bg-hub-card text-ink-2 hover:border-hub-line-strong hover:text-ink',
            )}
          >
            {option.label}
            <span
              className={cx(
                'tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] leading-none',
                selected && size === 'lg' ? 'bg-white/20 text-white' : 'bg-hub-card-2 text-ink-2',
                option.count === 0 && !selected && 'opacity-60',
              )}
            >
              {option.count}
              <span className="sr-only">{option.count === 1 ? ' KI-Tool' : ' KI-Tools'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function CategoryFilter({
  category,
  sub,
  counts,
  subCounts,
  onCategory,
  onSub,
}: {
  category: HubCategory | 'all';
  sub: string | null;
  counts: Record<HubCategory | 'all', number>;
  subCounts: Record<string, number>;
  onCategory: (category: HubCategory | 'all') => void;
  onSub: (sub: string | null) => void;
}) {
  const options: Option[] = [{ id: 'all', label: 'Alle', count: counts.all }, ...HUB_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id], count: counts[id] }))];
  const subs = subcategoriesOf(category);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <PillGroup label="Kategorie" options={options} active={category} onSelect={(id) => onCategory(id as HubCategory | 'all')} size="lg" />
      {category !== 'all' && subs.length > 0 ? (
        <div className="hub-fade-enter flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="hidden h-px w-4 shrink-0 bg-hub-line-strong sm:block" />
          <PillGroup
            label={`Unterkategorie in ${CATEGORY_LABELS[category]}`}
            options={[{ id: 'all', label: `Alle ${CATEGORY_LABELS[category]}`, count: subCounts.all ?? 0 }, ...subs.map((item) => ({ ...item, count: subCounts[item.id] ?? 0 }))]}
            active={sub ?? 'all'}
            onSelect={(id) => onSub(id === 'all' ? null : id)}
            size="sm"
          />
        </div>
      ) : null}
    </div>
  );
}
