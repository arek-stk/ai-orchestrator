'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last: only the top one reacts to Escape and traps Tab. */
const dialogStack: object[] = [];

/**
 * Modal behaviour for overlays: initial focus, Tab trap, Escape, body scroll lock and focus restore on close.
 * `closeOnEscape` is read at key time, so a dialog can refuse to close while it submits.
 */
export function useDialog({
  open,
  containerRef,
  onClose,
  initialFocusRef,
  closeOnEscape = true,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnEscape?: boolean;
}): void {
  const onCloseRef = useRef(onClose);
  const escapeRef = useRef(closeOnEscape);
  useEffect(() => {
    onCloseRef.current = onClose;
    escapeRef.current = closeOnEscape;
  });

  useEffect(() => {
    if (!open) return;
    const token = {};
    dialogStack.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container || container.contains(document.activeElement)) return;
      const target = initialFocusRef?.current ?? container.querySelector<HTMLElement>(FOCUSABLE) ?? container;
      target.focus({ preventScroll: true });
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (event.key === 'Escape') {
        if (!escapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        container.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      document.body.style.overflow = overflow;
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, containerRef, initialFocusRef]);
}

/** Closes a popover on outside pointer down and on Escape (returning focus to the trigger). */
export function usePopover(open: boolean, rootRef: RefObject<HTMLElement | null>, close: (returnFocus: boolean) => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeRef.current(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current(true);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    const root = rootRef.current;
    root?.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      root?.removeEventListener('keydown', onKey);
    };
  }, [open, rootRef]);
}
