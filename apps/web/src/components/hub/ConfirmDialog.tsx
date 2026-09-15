'use client';

import { LoaderCircle, Unplug } from 'lucide-react';
import { useId, useRef } from 'react';
import { cx } from '../ui';
import { actionBase } from './AICard';
import { useDialog } from './hooks';

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useDialog({ open: true, containerRef: ref, onClose: onCancel, initialFocusRef: cancelRef, closeOnEscape: !busy });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div aria-hidden="true" className="hub-fade-enter absolute inset-0 bg-[var(--hub-backdrop)]" onClick={() => !busy && onCancel()} />
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="hub-modal-enter relative w-full max-w-sm rounded-3xl border border-hub-line-strong bg-hub-card p-6 shadow-pop">
        <span aria-hidden="true" className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-critical-soft text-critical">
          <Unplug size={18} />
        </span>
        <h2 id={titleId} className="mt-4 text-[16px] font-semibold text-ink">
          {title}
        </h2>
        <p id={descriptionId} className="mt-1 text-[13px] text-ink-2">
          {description}
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded-xl bg-critical-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy} className={cx(actionBase, 'border border-hub-line-strong text-ink hover:bg-hub-card-2 disabled:opacity-50')}>
            Abbrechen
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={cx(actionBase, 'bg-critical text-white hover:bg-critical/90 disabled:opacity-60')}>
            {busy ? <LoaderCircle aria-hidden="true" size={14} className="animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
