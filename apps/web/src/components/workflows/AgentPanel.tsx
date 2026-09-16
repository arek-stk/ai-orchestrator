'use client';

import { ChevronDown, CircleAlert, Code2, Info, Minus, Plus, SlidersHorizontal, Thermometer, Trash2, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { FORMAT_LABELS, NODE_TYPE_LABELS, ROLE_LABELS } from '@/lib/workflows/presentation';
import type { AgentNode, NodeExecutability, WorkflowIssue, WorkflowMeta, WorkflowNode, WorkflowOutputFormat, WorkflowStep } from '@/lib/workflows/types';
import { StatePill } from '../hub/primitives';
import { cx } from '../ui';
import { fieldClass, labelClass, NodeAvatar, panelClass, StepStatusLabel, subtleButton, Tag, toolShortName } from './parts';

export interface AgentPanelProps {
  node: WorkflowNode;
  meta: WorkflowMeta;
  executability: NodeExecutability | undefined;
  step: WorkflowStep | undefined;
  issues: WorkflowIssue[];
  readOnly: boolean;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove: () => void;
  onClose: () => void;
  onShowCode: () => void;
}

function Section({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-hub-line pt-4">
      <h3 id={id} className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        {icon}
        {title}
      </h3>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function TextField({ label, value, onChange, disabled, maxLength, multiline, rows = 3, hint, placeholder }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; maxLength: number; multiline?: boolean; rows?: number; hint?: ReactNode; placeholder?: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} value={value} disabled={disabled} maxLength={maxLength} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cx(fieldClass, 'h-auto resize-y py-2 leading-relaxed')} />
      ) : (
        <input id={id} value={value} disabled={disabled} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={fieldClass} />
      )}
      {hint ? <p className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

function SelectField({ label, value, onChange, disabled, children, hint }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; children: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="relative">
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx(fieldClass, 'cursor-pointer appearance-none pr-9')}>
          {children}
        </select>
        <ChevronDown aria-hidden="true" size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2" />
      </div>
      {hint ? <p className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

function TagEditor({ tags, onChange, disabled, max }: { tags: string[]; onChange: (tags: string[]) => void; disabled: boolean; max: number }) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const add = () => {
    const value = draft.trim().slice(0, 24);
    if (!value || tags.includes(value) || tags.length >= max) return;
    onChange([...tags, value]);
    setDraft('');
  };
  return (
    <div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
        {tags.map((tag) => (
          <li key={tag}>
            <Tag className={disabled ? undefined : 'pr-1'}>
              {tag}
              {!disabled ? (
                <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} aria-label={`Tag ${tag} entfernen`} className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-hub-line">
                  <X aria-hidden="true" size={10} />
                </button>
              ) : null}
            </Tag>
          </li>
        ))}
        {tags.length === 0 ? <li className="text-xs text-ink-2">Keine Tags</li> : null}
      </ul>
      {!disabled && tags.length < max ? (
        <div className="mt-2 flex gap-2">
          <label htmlFor={id} className="sr-only">
            Tag hinzufügen
          </label>
          <input
            id={id}
            value={draft}
            maxLength={24}
            placeholder="Tag hinzufügen"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            className={cx(fieldClass, 'h-8')}
          />
          <button type="button" onClick={add} className={cx(subtleButton, 'h-8')} disabled={!draft.trim()}>
            Hinzufügen
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Stepper({ label, value, min, max, step, onChange, disabled }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; disabled: boolean }) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="flex items-center gap-1 rounded-[10px] border border-hub-line bg-hub-card-2 pr-1">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
          className="tabular h-9 min-w-0 flex-1 rounded-[10px] bg-transparent px-3 text-[13px] text-ink outline-none"
        />
        <button type="button" disabled={disabled || value <= min} onClick={() => onChange(clamp(value - step))} aria-label={`${label} verringern`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hub-line hover:text-ink disabled:opacity-40">
          <Minus aria-hidden="true" size={14} />
        </button>
        <button type="button" disabled={disabled || value >= max} onClick={() => onChange(clamp(value + step))} aria-label={`${label} erhöhen`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-hub-line hover:text-ink disabled:opacity-40">
          <Plus aria-hidden="true" size={14} />
        </button>
      </div>
    </div>
  );
}

function Switch({ checked, disabled, label, reason, onChange }: { checked: boolean; disabled: boolean; label: string; reason: string | null; onChange: (value: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={cx('text-[13px] text-ink', disabled && 'text-ink-2')}>
          {label}
        </label>
        {reason ? (
          <p id={`${id}-reason`} className="text-xs text-ink-2">
            {reason}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={reason ? `${id}-reason` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-[background-color,border-color] duration-150 ease-out after:absolute after:-inset-2.5 after:content-[''] disabled:cursor-not-allowed disabled:opacity-50",
          checked ? 'border-hub-cta bg-hub-cta' : 'border-hub-line-strong bg-hub-card-2',
        )}
      >
        <span className={cx('absolute h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

export function AgentPanel({ node, meta, executability, step, issues, readOnly, onChange, onRemove, onClose, onShowCode }: AgentPanelProps) {
  const limits = meta.limits;
  const tool = node.type === 'agent' ? meta.tools.find((t) => t.id === node.toolId) : undefined;
  const status = step ? null : node.type === 'agent' ? (executability?.executable ? { tone: 'good' as const, label: executability.demo ? 'Ausführbar · Demo' : 'Ausführbar' } : { tone: 'warning' as const, label: 'Nicht ausführbar' }) : { tone: 'accent' as const, label: NODE_TYPE_LABELS[node.type] };
  const agent = node.type === 'agent' ? node : null;
  const patchAgent = (patch: Partial<AgentNode>) => onChange(patch as Partial<WorkflowNode>);

  return (
    <aside aria-label={`Einstellungen: ${node.label}`} className={cx(panelClass, 'hub-panel-enter flex flex-col gap-4 p-4')}>
      <div className="flex items-start gap-3">
        <NodeAvatar node={node} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-semibold text-ink">{node.label}</h2>
          <p className="truncate text-[13px] text-ink-2">{agent ? toolShortName(agent.toolId) : NODE_TYPE_LABELS[node.type]}</p>
          <div className="mt-1.5">{step ? <StepStatusLabel status={step.status} /> : status ? <StatePill tone={status.tone} label={status.label} /> : null}</div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!readOnly ? (
            <button type="button" onClick={onRemove} aria-label={`${node.label} löschen`} title="Knoten löschen" className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 after:absolute after:-inset-1 after:content-[''] hover:bg-critical-soft hover:text-critical">
              <Trash2 aria-hidden="true" size={15} />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Panel schließen" className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 after:absolute after:-inset-1 after:content-[''] hover:bg-hub-card-2 hover:text-ink">
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </div>

      {agent && executability && !executability.executable ? (
        <div role="note" className="flex gap-2.5 rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] leading-snug text-ink">
          <CircleAlert aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <p className="font-medium">{executability.message}</p>
            <p className="mt-0.5 text-ink-2">
              Der Agent bleibt im Entwurf. Beim Ausführen blockiert der Lauf oder überspringt ihn sichtbar – je nach Auswahl.
              {tool && (tool.integration === 'native' || tool.integration === 'openai-compatible') ? ' Verbinde das Tool im AI Hub, um es auszuführen.' : ''}
            </p>
          </div>
        </div>
      ) : null}
      {step?.reason && step.status !== 'succeeded' ? <p className="rounded-xl border border-hub-line bg-hub-card-2 px-3 py-2 text-[13px] text-ink">{step.reason}</p> : null}
      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Hinweise zur Validierung">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className={cx('flex gap-2 text-xs', issue.severity === 'error' ? 'text-critical' : 'text-ink-2')}>
              <CircleAlert aria-hidden="true" size={13} className="mt-0.5 shrink-0" />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-3">
        <TextField label="Name" value={node.label} maxLength={limits.labelLength} disabled={readOnly} onChange={(label) => onChange({ label })} />
        {node.type === 'goal' ? (
          <TextField label="Ziel" multiline rows={4} value={node.goal} maxLength={limits.instructionsLength} disabled={readOnly} onChange={(goal) => onChange({ goal } as Partial<WorkflowNode>)} placeholder="Was soll der Workflow erreichen?" />
        ) : (
          <TextField label="Beschreibung" multiline rows={2} value={node.description} maxLength={300} disabled={readOnly} onChange={(description) => onChange({ description } as Partial<WorkflowNode>)} />
        )}
        {node.type === 'orchestrator' || node.type === 'join' ? (
          <p className="flex gap-2 text-xs text-ink-2">
            <Info aria-hidden="true" size={13} className="mt-0.5 shrink-0" />
            {node.type === 'orchestrator' ? 'Stufe 1: plant deterministisch aus der Graph-Struktur, ohne Modellaufruf und ohne eigene Entscheidungen.' : 'Führt die Ausgaben der eingehenden Schritte ohne Modellaufruf zusammen.'}
          </p>
        ) : null}
        {agent ? (
          <div>
            <p className={labelClass}>Tags</p>
            <div className="mt-1.5">
              <TagEditor tags={agent.tags} max={limits.maxTags} disabled={readOnly} onChange={(tags) => patchAgent({ tags })} />
            </div>
          </div>
        ) : null}
      </div>

      {agent ? (
        <>
          <Section title="Einstellungen">
            <SelectField label="Tool" value={agent.toolId} disabled={readOnly} onChange={(toolId) => patchAgent({ toolId, model: null })}>
              <optgroup label="Ausführbar">
                {meta.tools.filter((t) => t.executable).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Nur im Entwurf (nicht ausführbar)">
                {meta.tools.filter((t) => !t.executable).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} – {t.message.replace('Nicht ausführbar – ', '')}
                  </option>
                ))}
              </optgroup>
            </SelectField>
            <SelectField label="Rolle" value={agent.role} disabled={readOnly} onChange={(role) => patchAgent({ role: role as AgentNode['role'] })}>
              {meta.roles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Modell"
              value={agent.model ?? ''}
              disabled={readOnly}
              onChange={(model) => patchAgent({ model: model || null })}
              hint={meta.mode === 'demo' ? 'Demo-Modus: Es werden keine echten Modelle aufgerufen.' : tool && tool.models.length === 0 ? 'Für dieses Tool ist kein verfügbares Modell in der Registry.' : 'Aus der Modell-Registry. Fallbacks bleiben beim selben Anbieter.'}
            >
              <option value="">Automatisch (Routing im Tool)</option>
              {(tool?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
              {agent.model && !(tool?.models ?? []).some((m) => m.id === agent.model) ? <option value={agent.model}>{agent.model} (nicht verfügbar)</option> : null}
            </SelectField>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`${node.id}-temperature`} className={cx(labelClass, 'inline-flex items-center gap-1')}>
                  <Thermometer aria-hidden="true" size={13} />
                  Temperatur
                </label>
                <span className="tabular text-[13px] text-ink">{agent.temperature.toFixed(1)}</span>
              </div>
              <input
                id={`${node.id}-temperature`}
                type="range"
                min={limits.minTemperature}
                max={limits.maxTemperature}
                step={0.1}
                value={agent.temperature}
                disabled={readOnly}
                onChange={(e) => patchAgent({ temperature: Number(e.target.value) })}
                aria-describedby={`${node.id}-temperature-note`}
                className="wf-range w-full"
              />
              <p id={`${node.id}-temperature-note`} className="text-xs text-ink-2">
                Wird gespeichert; die Provider-Schnittstelle überträgt die Temperatur in Stufe 1 noch nicht.
              </p>
            </div>
            <Stepper label="Max. Tokens" value={agent.maxTokens} min={limits.minMaxTokens} max={limits.maxMaxTokens} step={250} disabled={readOnly} onChange={(maxTokens) => patchAgent({ maxTokens })} />
            <TextField label="Anweisungen" multiline rows={4} value={agent.instructions} maxLength={limits.instructionsLength} disabled={readOnly} onChange={(instructions) => patchAgent({ instructions })} hint="Wird dem Modell als nicht vertrauenswürdiger, abgegrenzter Inhalt übergeben." />
          </Section>

          <Section title="Tools & Integrationen">
            {meta.toggles.map((toggle) => (
              <Switch
                key={toggle.id}
                label={toggle.label}
                checked={toggle.toolName !== null && agent.enabledTools.includes(toggle.toolName)}
                disabled={readOnly || !toggle.available}
                reason={toggle.available ? null : toggle.reason}
                onChange={(on) => toggle.toolName && patchAgent({ enabledTools: on ? [...agent.enabledTools, toggle.toolName] : agent.enabledTools.filter((t) => t !== toggle.toolName) })}
              />
            ))}
          </Section>
        </>
      ) : null}

      {agent || node.type === 'finale' ? (
        <Section title="Ausgabe">
          <OutputFields node={node as AgentNode} readOnly={readOnly} note={meta.outputTargets.note} onChange={(output) => onChange({ output } as Partial<WorkflowNode>)} />
        </Section>
      ) : null}

      <details className="group border-t border-hub-line pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal aria-hidden="true" size={14} />
          Erweiterte Einstellungen
          <ChevronDown aria-hidden="true" size={15} className="ml-auto text-ink-2 transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-ink-2">Knoten-ID</dt>
          <dd className="truncate font-mono text-ink">{node.id}</dd>
          <dt className="text-ink-2">Typ</dt>
          <dd className="text-ink">{NODE_TYPE_LABELS[node.type]}</dd>
          {executability ? (
            <>
              <dt className="text-ink-2">Ausführbarkeit</dt>
              <dd className="text-ink">{executability.message}</dd>
              {executability.modelIds.length > 0 ? (
                <>
                  <dt className="text-ink-2">Erlaubte Modelle</dt>
                  <dd className="break-words font-mono text-ink">{executability.modelIds.join(', ')}</dd>
                </>
              ) : null}
            </>
          ) : null}
          {step ? (
            <>
              <dt className="text-ink-2">Modell im Lauf</dt>
              <dd className="font-mono text-ink">{step.modelId ?? '–'}</dd>
              <dt className="text-ink-2">Versuche</dt>
              <dd className="tabular text-ink">{step.attempts + (step.status === 'pending' ? 0 : 1)}</dd>
            </>
          ) : null}
        </dl>
      </details>

      <button type="button" onClick={onShowCode} className={cx(subtleButton, 'h-10 w-full border-hub-cta/60')}>
        <Code2 aria-hidden="true" size={15} />
        {agent ? 'Agent im Code bearbeiten' : 'Im Code bearbeiten'}
      </button>
    </aside>
  );
}

function OutputFields({ node, readOnly, note, onChange }: { node: AgentNode; readOnly: boolean; note: string; onChange: (output: AgentNode['output']) => void }) {
  return (
    <>
      <SelectField label="Format" value={node.output.format} disabled={readOnly} onChange={(format) => onChange({ ...node.output, format: format as WorkflowOutputFormat })}>
        {(Object.keys(FORMAT_LABELS) as WorkflowOutputFormat[]).map((format) => (
          <option key={format} value={format}>
            {FORMAT_LABELS[format]}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Ziel (Run-Artefakt)"
        value={node.output.artifactName}
        maxLength={120}
        disabled={readOnly}
        placeholder={node.id}
        onChange={(artifactName) => onChange({ ...node.output, artifactName })}
        hint={note}
      />
    </>
  );
}
