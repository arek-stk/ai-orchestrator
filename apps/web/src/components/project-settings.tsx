'use client';

import { Save } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useApi } from '@/hooks/use-api';
import { api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';
import { AGENT_ROLES, AUTONOMY_LABELS, GATED_ACTIONS, HARD_GATED_ACTIONS, type AgentRole, type ModelsResponse, type Project, type ProjectSettings } from '@/lib/types';
import { hasRole, useSession } from './providers';
import { Button, Card, ErrorBanner, Field, inputClass, textareaClass, Toggle } from './ui';

function SaveRow({ busy, disabled, saved, error, note }: { busy: boolean; disabled?: boolean; saved: boolean; error: string | null; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:col-span-2">
      {error ? <ErrorBanner error={error} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" icon={Save} busy={busy} disabled={disabled}>
          Save
        </Button>
        {saved ? (
          <span role="status" className="text-xs text-ink-2">
            Saved.
          </span>
        ) : null}
        {note ? <span className="text-xs text-ink-2">{note}</span> : null}
      </div>
    </div>
  );
}

function useSaver(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await fn();
      setSaved(true);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, saved, error, save };
}

const numberInput = (value: number, onChange: (n: number) => void, props: { id: string; min?: number; max?: number; step?: string; disabled?: boolean }) => (
  <input
    id={props.id}
    type="number"
    className={inputClass}
    value={Number.isFinite(value) ? value : ''}
    min={props.min}
    max={props.max}
    step={props.step ?? 'any'}
    disabled={props.disabled}
    onChange={(e) => onChange(Number(e.target.value))}
  />
);

export function ProjectSettingsTab({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const { user } = useSession();
  const isAdmin = hasRole(user, 'admin');
  const canOperate = hasRole(user, 'operator');
  const models = useApi<ModelsResponse>('/api/models');

  // General (operator)
  const [general, setGeneral] = useState({ name: project.name, description: project.description, priority: project.priority });
  const generalSaver = useSaver(reload);

  // Privileged (admin)
  const [autonomyLevel, setAutonomyLevel] = useState(project.autonomyLevel);
  const [budgetUsd, setBudgetUsd] = useState(project.budgetUsd);
  const [repo, setRepo] = useState({ owner: project.repo?.owner ?? '', name: project.repo?.name ?? '', defaultBranch: project.repo?.defaultBranch ?? 'main' });
  const [settings, setSettings] = useState<ProjectSettings>(project.settings);
  const adminSaver = useSaver(reload);

  useEffect(() => {
    setGeneral({ name: project.name, description: project.description, priority: project.priority });
    setAutonomyLevel(project.autonomyLevel);
    setBudgetUsd(project.budgetUsd);
    setRepo({ owner: project.repo?.owner ?? '', name: project.repo?.name ?? '', defaultBranch: project.repo?.defaultBranch ?? 'main' });
    setSettings(project.settings);
    // Re-sync only when the stored project changes.
  }, [project.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitGeneral = (event: FormEvent) => {
    event.preventDefault();
    void generalSaver.save(() =>
      api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: { name: general.name.trim(), description: general.description.trim(), priority: general.priority },
      }),
    );
  };

  const submitAdmin = (event: FormEvent) => {
    event.preventDefault();
    const hasRepo = repo.owner.trim() && repo.name.trim();
    void adminSaver.save(() =>
      api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: {
          autonomyLevel,
          budgetUsd,
          repo: hasRepo ? { owner: repo.owner.trim(), name: repo.name.trim(), defaultBranch: repo.defaultBranch.trim() || 'main' } : null,
          settings: {
            stopConditions: settings.stopConditions,
            council: settings.council,
            approvalGates: settings.approvalGates,
            highCostThresholdUsd: settings.highCostThresholdUsd,
            maxConcurrentTasks: settings.maxConcurrentTasks,
            modelOverrides: Object.fromEntries(Object.entries(settings.modelOverrides).filter(([, v]) => v)),
          },
        },
      }),
    );
  };

  const setStop = (key: keyof ProjectSettings['stopConditions'], value: number) => setSettings((s) => ({ ...s, stopConditions: { ...s.stopConditions, [key]: value } }));
  const setCouncil = (key: keyof ProjectSettings['council'], value: number) => setSettings((s) => ({ ...s, council: { ...s.council, [key]: value } }));
  const disabled = !isAdmin;
  const modelOptions = (models.data?.models ?? []).filter((m) => m.enabled);

  return (
    <div className="flex flex-col gap-6">
      <Card title="General" description="Operators can edit name, description and priority.">
        <form onSubmit={submitGeneral} className="grid gap-4 md:grid-cols-2">
          <Field label="Name" htmlFor="ps-name">
            <input id="ps-name" required minLength={2} maxLength={120} className={inputClass} disabled={!canOperate} value={general.name} onChange={(e) => setGeneral({ ...general, name: e.target.value })} />
          </Field>
          <Field label="Priority (1-10)" htmlFor="ps-priority">
            {numberInput(general.priority, (n) => setGeneral({ ...general, priority: n }), { id: 'ps-priority', min: 1, max: 10, step: '1', disabled: !canOperate })}
          </Field>
          <Field label="Description" htmlFor="ps-description" className="md:col-span-2">
            <textarea id="ps-description" rows={2} maxLength={2000} className={textareaClass} disabled={!canOperate} value={general.description} onChange={(e) => setGeneral({ ...general, description: e.target.value })} />
          </Field>
          <SaveRow busy={generalSaver.busy} saved={generalSaver.saved} error={generalSaver.error} disabled={!canOperate} note={!canOperate ? 'Requires the operator role.' : undefined} />
        </form>
      </Card>

      <form onSubmit={submitAdmin} className="flex flex-col gap-6">
        {!isAdmin ? (
          <p className="rounded-lg border border-line bg-warning-soft px-4 py-3 text-sm text-ink">
            Autonomy, repository, budget, approval gates, stop conditions, council and model overrides require the admin role. You are signed in as {user?.role ?? 'viewer'}.
          </p>
        ) : null}

        <Card title="Autonomy, repository and budget">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Autonomy level" htmlFor="ps-autonomy">
              <select id="ps-autonomy" className={inputClass} disabled={disabled} value={autonomyLevel} onChange={(e) => setAutonomyLevel(Number(e.target.value))}>
                {[0, 1, 2, 3, 4].map((level) => (
                  <option key={level} value={level}>
                    {level} · {AUTONOMY_LABELS[level]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Budget (USD)" htmlFor="ps-budget">
              {numberInput(budgetUsd, setBudgetUsd, { id: 'ps-budget', min: 0, max: 100000, step: '0.01', disabled })}
            </Field>
            <Field label="Repository owner" htmlFor="ps-owner">
              <input id="ps-owner" className={inputClass} disabled={disabled} value={repo.owner} onChange={(e) => setRepo({ ...repo, owner: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Repository name" htmlFor="ps-repo">
                <input id="ps-repo" className={inputClass} disabled={disabled} value={repo.name} onChange={(e) => setRepo({ ...repo, name: e.target.value })} />
              </Field>
              <Field label="Default branch" htmlFor="ps-branch">
                <input id="ps-branch" className={inputClass} disabled={disabled} value={repo.defaultBranch} onChange={(e) => setRepo({ ...repo, defaultBranch: e.target.value })} />
              </Field>
            </div>
            <Field label="High-cost threshold (USD)" htmlFor="ps-highcost" hint="Runs above this cost need the high-cost approval.">
              {numberInput(settings.highCostThresholdUsd, (n) => setSettings({ ...settings, highCostThresholdUsd: n }), { id: 'ps-highcost', min: 0, step: '0.01', disabled })}
            </Field>
            <Field label="Max concurrent tasks" htmlFor="ps-concurrent">
              {numberInput(settings.maxConcurrentTasks, (n) => setSettings({ ...settings, maxConcurrentTasks: n }), { id: 'ps-concurrent', min: 1, max: 20, step: '1', disabled })}
            </Field>
          </div>
        </Card>

        <Card title="Approval gates" description="Actions that pause the pipeline until a human approves.">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {GATED_ACTIONS.map((gate) => {
              // Hard gates (ADR-031) are always on and cannot be changed here.
              const hard = HARD_GATED_ACTIONS.includes(gate);
              return (
                <Toggle
                  key={gate}
                  label={humanize(gate)}
                  disabled={disabled || hard}
                  checked={hard ? true : (settings.approvalGates[gate] ?? true)}
                  {...(hard ? { description: 'Always required for every new dependency' } : {})}
                  onChange={(checked) => setSettings((s) => ({ ...s, approvalGates: { ...s.approvalGates, [gate]: checked } }))}
                />
              );
            })}
          </div>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Stop conditions" description="Per-run hard limits.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max iterations" htmlFor="sc-iter">
                {numberInput(settings.stopConditions.maxIterations, (n) => setStop('maxIterations', n), { id: 'sc-iter', min: 1, max: 100, step: '1', disabled })}
              </Field>
              <Field label="Max cost per run (USD)" htmlFor="sc-cost">
                {numberInput(settings.stopConditions.maxCostUsd, (n) => setStop('maxCostUsd', n), { id: 'sc-cost', min: 0.01, step: '0.01', disabled })}
              </Field>
              <Field label="Max tokens" htmlFor="sc-tokens">
                {numberInput(settings.stopConditions.maxTokens, (n) => setStop('maxTokens', n), { id: 'sc-tokens', min: 1, step: '1', disabled })}
              </Field>
              <Field label="Max runtime (minutes)" htmlFor="sc-runtime">
                {numberInput(Math.round(settings.stopConditions.maxRuntimeMs / 60000), (n) => setStop('maxRuntimeMs', n * 60000), { id: 'sc-runtime', min: 1, step: '1', disabled })}
              </Field>
              <Field label="Max debug attempts" htmlFor="sc-debug">
                {numberInput(settings.stopConditions.maxDebugAttempts, (n) => setStop('maxDebugAttempts', n), { id: 'sc-debug', min: 0, max: 10, step: '1', disabled })}
              </Field>
            </div>
          </Card>
          <Card title="Council" description="Multi-agent consultation for design decisions.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max rounds" htmlFor="co-rounds">
                {numberInput(settings.council.maxRounds, (n) => setCouncil('maxRounds', n), { id: 'co-rounds', min: 1, max: 5, step: '1', disabled })}
              </Field>
              <Field label="Confidence threshold (0.5-1)" htmlFor="co-threshold">
                {numberInput(settings.council.confidenceThreshold, (n) => setCouncil('confidenceThreshold', n), { id: 'co-threshold', min: 0.5, max: 1, step: '0.01', disabled })}
              </Field>
              <Field label="Max tokens" htmlFor="co-tokens">
                {numberInput(settings.council.maxTokens, (n) => setCouncil('maxTokens', n), { id: 'co-tokens', min: 1, step: '1', disabled })}
              </Field>
              <Field label="Timeout (seconds)" htmlFor="co-timeout">
                {numberInput(Math.round(settings.council.timeoutMs / 1000), (n) => setCouncil('timeoutMs', n * 1000), { id: 'co-timeout', min: 10, step: '1', disabled })}
              </Field>
            </div>
          </Card>
        </div>

        <Card title="Model overrides" description="Pin an agent role to a specific model for this project. Automatic routing is used otherwise.">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {AGENT_ROLES.map((role: AgentRole) => (
              <Field key={role} label={humanize(role)} htmlFor={`mo-${role}`}>
                <select
                  id={`mo-${role}`}
                  className={inputClass}
                  disabled={disabled}
                  value={settings.modelOverrides[role] ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, modelOverrides: { ...s.modelOverrides, [role]: e.target.value } }))}
                >
                  <option value="">Automatic</option>
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                  {settings.modelOverrides[role] && !modelOptions.some((m) => m.id === settings.modelOverrides[role]) ? (
                    <option value={settings.modelOverrides[role]}>{settings.modelOverrides[role]}</option>
                  ) : null}
                </select>
              </Field>
            ))}
          </div>
        </Card>

        <div className="grid">
          <SaveRow busy={adminSaver.busy} saved={adminSaver.saved} error={adminSaver.error} disabled={disabled} note={disabled ? 'Requires the admin role.' : 'Saves autonomy, repository, budget, gates, limits, council and overrides.'} />
        </div>
      </form>
    </div>
  );
}
