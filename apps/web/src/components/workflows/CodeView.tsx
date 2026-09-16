'use client';

import { Check, CircleAlert, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { lineOfId, parseDefinitionText, serializeDefinition } from '@/lib/workflows/code';
import type { NodeExecutability, WorkflowDefinition, WorkflowIssue } from '@/lib/workflows/types';
import { cx } from '../ui';
import { panelClass, primaryButton, subtleButton } from './parts';

interface ValidateResponse {
  validation: { valid: boolean; issues: WorkflowIssue[] };
  executability: Record<string, NodeExecutability>;
}

/**
 * JSON representation of the workflow, editable. Syntax errors are found locally (with line and column); schema and graph
 * rules come from the server's validator so the editor never disagrees with what saving would accept.
 */
export function CodeView({ definition, readOnly, focusNodeId, onApply }: { definition: WorkflowDefinition; readOnly: boolean; focusNodeId: string | null; onApply: (definition: WorkflowDefinition) => void }) {
  const canonical = useMemo(() => serializeDefinition(definition), [definition]);
  const [text, setText] = useState(canonical);
  const [edited, setEdited] = useState(false);
  const [server, setServer] = useState<{ text: string; result: ValidateResponse | null; error: string | null } | null>(null);
  const [validating, setValidating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Follow visual edits until the user starts typing here.
  useEffect(() => {
    if (!edited) setText(canonical);
  }, [canonical, edited]);

  const parsed = useMemo(() => parseDefinitionText(text), [text]);

  useEffect(() => {
    if (!parsed.ok) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setValidating(true);
      api<ValidateResponse>('/api/workflows/validate', { method: 'POST', body: { definition: parsed.value } })
        .then((result) => !cancelled && setServer({ text, result, error: null }))
        .catch((error) => !cancelled && setServer({ text, result: null, error: errorMessage(error) }))
        .finally(() => !cancelled && setValidating(false));
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [parsed, text]);

  // Jump to the selected node's JSON when opened from the panel.
  useEffect(() => {
    if (!focusNodeId || !textareaRef.current) return;
    const line = lineOfId(text, focusNodeId);
    if (!line) return;
    const offset = text.split('\n').slice(0, line - 1).join('\n').length + 1;
    const area = textareaRef.current;
    area.focus({ preventScroll: true });
    area.setSelectionRange(offset, offset);
    area.scrollTop = Math.max(0, (line - 3) * 20);
    // Only on open / focus change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId]);

  const current = server && server.text === text ? server : null;
  const issues = current?.result?.validation.issues ?? [];
  const schemaBroken = issues.some((issue) => issue.code === 'schema' || issue.code.startsWith('too_many'));
  const lines = text.split('\n').length;
  const errorLine = !parsed.ok ? parsed.error.line : null;
  const issueLines = new Set(issues.filter((i) => i.severity === 'error' && i.nodeId).map((i) => lineOfId(text, i.nodeId!)).filter((l): l is number => l !== null));
  const canApply = !readOnly && edited && parsed.ok && current?.result !== undefined && current?.result !== null && !schemaBroken;

  return (
    <div className={cx(panelClass, 'flex h-full min-h-[480px] flex-col overflow-hidden')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-hub-line px-3 py-2">
        <p className="text-[13px] font-medium text-ink">workflow.json</p>
        <span className="text-xs text-ink-2">{readOnly ? 'Nur lesen' : edited ? 'Geändert – mit „Übernehmen“ in die Visualisierung übertragen' : 'Synchron mit der Visualisierung'}</span>
        <div className="ml-auto flex items-center gap-2">
          {edited ? (
            <button
              type="button"
              className={cx(subtleButton, 'h-8')}
              onClick={() => {
                setEdited(false);
                setText(canonical);
              }}
            >
              <RotateCcw aria-hidden="true" size={14} />
              Verwerfen
            </button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              className={cx(primaryButton, 'h-8')}
              disabled={!canApply}
              onClick={() => {
                if (!parsed.ok) return;
                onApply(parsed.value as WorkflowDefinition);
                setEdited(false);
              }}
            >
              <Check aria-hidden="true" size={14} />
              Übernehmen
            </button>
          ) : null}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={gutterRef} aria-hidden="true" className="tabular w-12 shrink-0 select-none overflow-hidden border-r border-hub-line bg-hub-card-2 py-3 pr-2 text-right font-mono text-[12px] leading-5 text-muted">
          {Array.from({ length: lines }, (_, index) => (
            <div key={index} className={cx(errorLine === index + 1 && 'text-critical font-semibold', issueLines.has(index + 1) && 'text-warning font-semibold')}>
              {index + 1}
            </div>
          ))}
        </div>
        <label htmlFor="workflow-code" className="sr-only">
          Workflow als JSON
        </label>
        <textarea
          id="workflow-code"
          ref={textareaRef}
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          aria-invalid={!parsed.ok || issues.some((i) => i.severity === 'error')}
          aria-describedby="workflow-code-status"
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onChange={(event) => {
            setText(event.target.value);
            setEdited(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Tab' || readOnly || event.shiftKey) return;
            // Indent with two spaces; Escape then Tab leaves the editor (see hint below).
            event.preventDefault();
            const area = event.currentTarget;
            const { selectionStart, selectionEnd } = area;
            const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
            setText(next);
            setEdited(true);
            requestAnimationFrame(() => area.setSelectionRange(selectionStart + 2, selectionStart + 2));
          }}
          className="min-h-0 flex-1 resize-none bg-hub-card px-3 py-3 font-mono text-[12.5px] leading-5 text-ink outline-none"
        />
      </div>

      <div id="workflow-code-status" aria-live="polite" className="max-h-44 overflow-y-auto border-t border-hub-line px-3 py-2.5 text-[13px]">
        {!parsed.ok ? (
          <p className="flex gap-2 text-critical">
            <CircleAlert aria-hidden="true" size={15} className="mt-0.5 shrink-0" />
            <span>
              {parsed.error.line ? `Zeile ${parsed.error.line}${parsed.error.column ? `, Spalte ${parsed.error.column}` : ''}: ` : ''}
              {parsed.error.message}
            </span>
          </p>
        ) : validating && !current ? (
          <p className="flex items-center gap-2 text-ink-2">
            <LoaderCircle aria-hidden="true" size={14} className="animate-spin" />
            Wird geprüft …
          </p>
        ) : current?.error ? (
          <p className="text-critical">Prüfung fehlgeschlagen: {current.error}</p>
        ) : issues.length === 0 && current ? (
          <p className="flex items-center gap-2 text-hub-connected">
            <Check aria-hidden="true" size={15} />
            Gültig: keine Fehler, keine Hinweise.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => {
              const line = issue.nodeId ? lineOfId(text, issue.nodeId) : null;
              return (
                <li key={`${issue.code}-${index}`} className={cx('flex gap-2', issue.severity === 'error' ? 'text-critical' : 'text-ink-2')}>
                  {issue.severity === 'error' ? <CircleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" /> : <TriangleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0 text-warning" />}
                  <span>
                    {line ? <span className="tabular font-mono text-xs">Z. {line} · </span> : null}
                    {issue.message}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {!readOnly ? <p className="mt-1.5 text-xs text-muted">Tab rückt ein. Zum Verlassen des Editors Shift+Tab verwenden.</p> : null}
      </div>
    </div>
  );
}
