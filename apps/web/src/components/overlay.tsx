'use client';

import { X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useDialog, usePopover } from './hub/hooks';
import { cx, IconButton } from './ui';

// Modal dialog and menu button in the product design system (tokens, light/dark), built on the shared focus-trap and
// popover hooks. Used by the board and roadmap.

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  role = 'dialog',
  busy = false,
  initialFocusRef,
  size = 'md',
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useDialog({ open: true, containerRef: ref, onClose, closeOnEscape: !busy, ...(initialFocusRef ? { initialFocusRef } : {}) });
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-ink/30" onClick={() => !busy && onClose()} />
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          'enter relative flex max-h-[92dvh] w-full flex-col rounded-t-[14px] border border-line bg-surface shadow-pop sm:rounded-[12px]',
          size === 'sm' ? 'sm:max-w-md' : 'sm:max-w-xl',
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="mt-0.5 text-[13px] text-ink-2">
                {description}
              </div>
            ) : null}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} disabled={busy} />
        </div>
        {children ? <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div> : null}
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface MenuAction {
  key: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * WAI-ARIA menu button. Enter, Space or ArrowDown open on the first item, ArrowUp on the last; arrow keys, Home and End
 * move within the menu; Escape closes and returns focus to the button.
 */
export function MenuButton({ label, icon: Icon, actions, className, buttonLabel }: { label: string; icon: LucideIcon; actions: MenuAction[]; className?: string; buttonLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  usePopover(open, rootRef, close);

  // The menu is positioned fixed next to the button, so scroll containers (board columns) never clip it.
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom;
    setPosition(below < 260 && rect.top > below ? { left, bottom: window.innerHeight - rect.top + 4, width } : { left, top: rect.bottom + 4, width });
  };

  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => close(false);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const openAt = (index: number) => {
    if (actions.length === 0) return;
    place();
    setOpen(true);
    requestAnimationFrame(() => itemRefs.current[index]?.focus({ preventScroll: true }));
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(actions.length - 1);
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (current + 1) % actions.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + actions.length) % actions.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = actions.length - 1;
    else if (event.key === 'Tab') close(false);
    if (next < 0) return;
    event.preventDefault();
    itemRefs.current[next]?.focus({ preventScroll: true });
  };

  return (
    <div ref={rootRef} className={cx('relative', className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={actions.length === 0}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKey}
        className={cx(
          "relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs text-ink-2 transition-[color,background-color] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-9 pointer-coarse:min-w-9",
          open && 'bg-surface-2 text-ink',
        )}
      >
        <Icon aria-hidden="true" size={15} />
        {buttonLabel ? <span>{buttonLabel}</span> : null}
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKey} style={position} className="enter fixed z-[55] rounded-[10px] border border-line bg-surface p-1 shadow-pop">
          {actions.map((action, index) => (
            <button
              key={action.key}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(true);
                action.onSelect();
              }}
              className={cx(
                'flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-[background-color,color] duration-150 ease-out hover:bg-surface-2 focus-visible:bg-surface-2',
                action.danger && 'hover:text-critical focus-visible:text-critical',
              )}
            >
              {action.icon ? <action.icon aria-hidden="true" size={14} className={action.danger ? 'text-critical' : 'text-ink-2'} /> : null}
              <span className="flex-1">{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
