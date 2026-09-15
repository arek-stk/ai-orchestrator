'use client';

import { ArrowUpRight, EllipsisVertical, PanelRight, Unplug, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../ui';
import { usePopover } from './hooks';

interface MenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  danger?: boolean;
  onSelect?: () => void;
}

/** WAI-ARIA menu button: Enter/Space/ArrowDown open on the first item, ArrowUp on the last, Escape returns focus. */
export function CardMenu({
  toolName,
  website,
  showDisconnect,
  onDetails,
  onDisconnect,
  onOpenChange,
}: {
  toolName: string;
  website: string;
  showDisconnect: boolean;
  onDetails: () => void;
  onDisconnect: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const menuId = useId();

  const items: MenuItem[] = [
    { key: 'details', label: 'Details', icon: PanelRight, onSelect: onDetails },
    { key: 'website', label: 'Offizielle Website', icon: ArrowUpRight, href: website },
    ...(showDisconnect ? [{ key: 'disconnect', label: 'Trennen', icon: Unplug, danger: true, onSelect: onDisconnect }] : []),
  ];

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  usePopover(open, rootRef, close);

  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  const openAt = (index: number) => {
    setOpen(true);
    requestAnimationFrame(() => itemRefs.current[index]?.focus());
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(items.length - 1);
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') close(false);
    if (next < 0) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  };

  const itemClass = (danger?: boolean) =>
    cx(
      'flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none transition-[background-color,color] duration-150 ease-out focus-visible:bg-hub-card-2 hover:bg-hub-card-2',
      danger ? 'text-ink hover:text-critical focus-visible:text-critical' : 'text-ink',
    );

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Weitere Aktionen für ${toolName}`}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKey}
        className={cx(
          "relative -mr-1.5 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-[color,background-color] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-hub-card-2 hover:text-ink",
          open && 'bg-hub-card-2 text-ink',
        )}
      >
        <EllipsisVertical aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Aktionen für ${toolName}`}
          onKeyDown={onMenuKey}
          className="hub-fade-enter absolute right-0 top-full z-30 mt-1.5 w-52 rounded-xl border border-hub-line-strong bg-hub-card p-1 shadow-pop"
        >
          {items.map((item, index) => {
            const content = (
              <>
                <item.icon aria-hidden="true" size={15} className={item.danger ? 'text-critical' : 'text-ink-2'} />
                <span className="flex-1">{item.label}</span>
              </>
            );
            const ref = (el: HTMLElement | null) => {
              itemRefs.current[index] = el;
            };
            return item.href ? (
              <a key={item.key} ref={ref} role="menuitem" tabIndex={-1} href={item.href} target="_blank" rel="noopener noreferrer" onClick={() => close(false)} className={itemClass()}>
                {content}
                <span className="sr-only">(öffnet in neuem Tab)</span>
              </a>
            ) : (
              <button
                key={item.key}
                ref={ref}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(false);
                  item.onSelect?.();
                }}
                className={itemClass(item.danger)}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
