'use client';

import { Pencil, Plus, Save, Trash, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { hasRole, useSession } from '@/components/providers';
import { Button, Card, Chip, cx, EmptyState, ErrorBanner, Field, inputClass, Loading, PageHeader, RelativeTime, StatusBadge, TableWrap, td, th, Toggle } from '@/components/ui';
import { useAction, useApi } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { formatTokens, formatUsd, humanize } from '@/lib/format';
import {
  AGENT_ROLES,
  EDITABLE_PROVIDER_KINDS,
  MODEL_TIERS,
  USER_ROLES,
  type GlobalSettings,
  type ModelConfig,
  type ModelsResponse,
  type ProviderInfo,
  type SettingsResponse,
  type UserInfo,
  type UserRole,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

function GlobalSettingsCard({ isAdmin, models }: { isAdmin: boolean; models: ModelsResponse['models'] }) {
  const { data, error, reload } = useApi<SettingsResponse>('/api/settings');
  const [form, setForm] = useState<GlobalSettings | null>(null);
  const action = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaved(false);
    void action.run('save', async () => {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          globalDailyBudgetUsd: form.globalDailyBudgetUsd,
          globalCapacity: form.globalCapacity,
          modelOverrides: Object.fromEntries(Object.entries(form.modelOverrides).filter(([, v]) => v)),
        },
      });
      setSaved(true);
      await reload();
    });
  };

  return (
    <Card title="Global settings" description={isAdmin ? 'Applies to every project.' : 'Read-only: editing requires the admin role.'}>
      <ErrorBanner error={error} onRetry={() => void reload()} />
      {!form ? (
        error ? null : <Loading />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Daily budget (USD)" htmlFor="gs-budget" hint="Across all projects.">
              <input id="gs-budget" type="number" min={0} step="0.01" disabled={!isAdmin} className={inputClass} value={form.globalDailyBudgetUsd} onChange={(e) => setForm({ ...form, globalDailyBudgetUsd: Number(e.target.value) })} />
            </Field>
            <Field label="Global capacity" htmlFor="gs-capacity" hint="Concurrent pipeline runs (1-64).">
              <input id="gs-capacity" type="number" min={1} max={64} step="1" disabled={!isAdmin} className={inputClass} value={form.globalCapacity} onChange={(e) => setForm({ ...form, globalCapacity: Number(e.target.value) })} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-ink-2">Model overrides per agent role</legend>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {AGENT_ROLES.map((role) => (
                <Field key={role} label={humanize(role)} htmlFor={`gs-mo-${role}`}>
                  <select
                    id={`gs-mo-${role}`}
                    disabled={!isAdmin}
                    className={inputClass}
                    value={form.modelOverrides[role] ?? ''}
                    onChange={(e) => setForm({ ...form, modelOverrides: { ...form.modelOverrides, [role]: e.target.value } })}
                  >
                    <option value="">Automatic</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          </fieldset>
          <ErrorBanner error={action.error} onDismiss={action.clearError} />
          {isAdmin ? (
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" icon={Save} busy={action.pending === 'save'}>
                Save settings
              </Button>
              {saved ? (
                <span role="status" className="text-xs text-ink-2">
                  Saved.
                </span>
              ) : null}
            </div>
          ) : null}
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function stripModel(model: ModelConfig & { available?: boolean }): ModelConfig {
  const { available: _available, ...rest } = model;
  return rest;
}

function ModelEditor({ model, onCancel, onSaved }: { model: ModelConfig; onCancel: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ModelConfig>(model);
  const action = useAction();
  const num = (value: string) => Number(value);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run('save', async () => {
      await api(`/api/models/${encodeURIComponent(model.id)}`, { method: 'PUT', body: form });
      onSaved();
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-md bg-surface-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Display name" htmlFor={`me-name-${model.id}`}>
        <input id={`me-name-${model.id}`} required className={inputClass} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </Field>
      <Field label="Tier" htmlFor={`me-tier-${model.id}`}>
        <select id={`me-tier-${model.id}`} className={inputClass} value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value as ModelConfig['tier'] })}>
          {MODEL_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {humanize(tier)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Context window" htmlFor={`me-ctx-${model.id}`}>
        <input id={`me-ctx-${model.id}`} type="number" min={1000} className={inputClass} value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: num(e.target.value) })} />
      </Field>
      <Field label="Max output tokens" htmlFor={`me-out-${model.id}`}>
        <input id={`me-out-${model.id}`} type="number" min={256} className={inputClass} value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: num(e.target.value) })} />
      </Field>
      <Field label="Input $ / MTok" htmlFor={`me-in-${model.id}`}>
        <input id={`me-in-${model.id}`} type="number" min={0} step="0.001" className={inputClass} value={form.pricing.inputPerMTok} onChange={(e) => setForm({ ...form, pricing: { ...form.pricing, inputPerMTok: num(e.target.value) } })} />
      </Field>
      <Field label="Output $ / MTok" htmlFor={`me-o-${model.id}`}>
        <input id={`me-o-${model.id}`} type="number" min={0} step="0.001" className={inputClass} value={form.pricing.outputPerMTok} onChange={(e) => setForm({ ...form, pricing: { ...form.pricing, outputPerMTok: num(e.target.value) } })} />
      </Field>
      <Field label="Coding score (0-100)" htmlFor={`me-cs-${model.id}`}>
        <input id={`me-cs-${model.id}`} type="number" min={0} max={100} className={inputClass} value={form.codingScore} onChange={(e) => setForm({ ...form, codingScore: num(e.target.value) })} />
      </Field>
      <Field label="Reasoning score (0-100)" htmlFor={`me-rs-${model.id}`}>
        <input id={`me-rs-${model.id}`} type="number" min={0} max={100} className={inputClass} value={form.reasoningScore} onChange={(e) => setForm({ ...form, reasoningScore: num(e.target.value) })} />
      </Field>
      <Field label="Latency" htmlFor={`me-lat-${model.id}`}>
        <select id={`me-lat-${model.id}`} className={inputClass} value={form.latency} onChange={(e) => setForm({ ...form, latency: e.target.value as ModelConfig['latency'] })}>
          {['low', 'medium', 'high'].map((l) => (
            <option key={l} value={l}>
              {humanize(l)}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end pb-1.5">
        <Toggle label="Enabled" checked={form.enabled} onChange={(checked) => setForm({ ...form, enabled: checked })} />
      </div>
      {action.error ? <ErrorBanner error={action.error} className="sm:col-span-2 lg:col-span-4" /> : null}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" variant="primary" icon={Save} busy={action.pending === 'save'}>
          Save model
        </Button>
        <Button icon={X} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ModelsCard({ isAdmin, models }: { isAdmin: boolean; models: ReturnType<typeof useApi<ModelsResponse>> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const action = useAction();
  const data = models.data;

  const toggle = (model: ModelsResponse['models'][number], enabled: boolean) =>
    void action.run(`toggle:${model.id}`, async () => {
      await api(`/api/models/${encodeURIComponent(model.id)}`, { method: 'PUT', body: { ...stripModel(model), enabled } });
      await models.reload();
    });

  return (
    <Card title="Models" description={data?.demoMode ? 'Demo mode: no real provider is usable, so mock models serve every call.' : 'Models the router can choose from.'}>
      <ErrorBanner error={models.error} onRetry={() => void models.reload()} />
      <ErrorBanner error={action.error} onDismiss={action.clearError} className="mb-3" />
      {!data ? (
        models.error ? null : <Loading />
      ) : data.models.length === 0 ? (
        <EmptyState title="No models configured" />
      ) : (
        <TableWrap label="Models">
          <thead>
            <tr>
              <th scope="col" className={th}>Model</th>
              <th scope="col" className={th}>Provider</th>
              <th scope="col" className={th}>Tier</th>
              <th scope="col" className={cx(th, 'text-right')}>Context</th>
              <th scope="col" className={cx(th, 'text-right')}>In / out per MTok</th>
              <th scope="col" className={cx(th, 'text-right')}>Coding / reasoning</th>
              <th scope="col" className={th}>Availability</th>
              <th scope="col" className={th}>Enabled</th>
              {isAdmin ? <th scope="col" className={th}><span className="sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {data.models.map((model) => (
              <FragmentRow key={model.id} colSpan={isAdmin ? 9 : 8} editor={editing === model.id ? <ModelEditor model={stripModel(model)} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void models.reload(); }} /> : null}>
                <td className={td}>
                  <div className="font-medium">{model.displayName}</div>
                  <div className="font-mono text-xs text-ink-2">{model.id}</div>
                </td>
                <td className={td}>{model.provider}</td>
                <td className={td}>{humanize(model.tier)}</td>
                <td className={cx(td, 'tabular text-right')}>{formatTokens(model.contextWindow)}</td>
                <td className={cx(td, 'tabular whitespace-nowrap text-right')}>
                  {formatUsd(model.pricing.inputPerMTok)} / {formatUsd(model.pricing.outputPerMTok)}
                </td>
                <td className={cx(td, 'tabular text-right')}>
                  {model.codingScore} / {model.reasoningScore}
                </td>
                <td className={td}>
                  <StatusBadge tone={model.available ? 'good' : 'muted'} label={model.available ? 'Available' : 'No provider'} />
                </td>
                <td className={td}>
                  <Toggle label={model.enabled ? 'On' : 'Off'} checked={model.enabled} disabled={!isAdmin || action.pending === `toggle:${model.id}`} onChange={(checked) => toggle(model, checked)} />
                </td>
                {isAdmin ? (
                  <td className={td}>
                    <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Edit ${model.displayName}`} onClick={() => setEditing(editing === model.id ? null : model.id)}>
                      Edit
                    </Button>
                  </td>
                ) : null}
              </FragmentRow>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}

function FragmentRow({ children, editor, colSpan }: { children: React.ReactNode; editor: React.ReactNode; colSpan: number }) {
  return (
    <>
      <tr>{children}</tr>
      {editor ? (
        <tr>
          <td colSpan={colSpan} className="border-b border-line py-3">
            {editor}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const emptyProvider = { id: '', kind: 'anthropic' as string, name: '', baseUrl: '', apiKey: '', removeKey: false, enabled: true };

function ProvidersCard({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const { data, error, reload } = useApi<{ providers: ProviderInfo[] }>('/api/providers');
  const [form, setForm] = useState<typeof emptyProvider | null>(null);
  const action = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    void action.run('save', async () => {
      await api(`/api/providers/${encodeURIComponent(form.id.trim())}`, {
        method: 'PUT',
        body: {
          kind: form.kind,
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim() ? form.baseUrl.trim() : null,
          enabled: form.enabled,
          ...(form.removeKey ? { apiKey: null } : form.apiKey ? { apiKey: form.apiKey } : {}),
        },
      });
      setForm(null);
      await reload();
      onChanged();
    });
  };

  const remove = (provider: ProviderInfo) => {
    if (!window.confirm(`Delete provider "${provider.name}"?`)) return;
    void action.run(`delete:${provider.id}`, async () => {
      await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      await reload();
      onChanged();
    });
  };

  return (
    <Card
      title="Providers"
      description="Provider accounts. Environment providers are read-only; API keys are write-only and stored encrypted."
      actions={
        isAdmin && !form ? (
          <Button size="sm" icon={Plus} onClick={() => setForm({ ...emptyProvider })}>
            Add provider
          </Button>
        ) : null
      }
    >
      <ErrorBanner error={error} onRetry={() => void reload()} />
      <ErrorBanner error={action.error} onDismiss={action.clearError} className="mb-3" />
      {form ? (
        <form onSubmit={submit} className="mb-5 grid gap-3 rounded-md bg-surface-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Id" htmlFor="pv-id" hint="Lowercase letters, digits and dashes.">
            <input id="pv-id" required pattern="[a-z0-9\-]{2,60}" className={inputClass} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          </Field>
          <Field label="Kind" htmlFor="pv-kind">
            <select id="pv-kind" className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {EDITABLE_PROVIDER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" htmlFor="pv-name">
            <input id="pv-name" required maxLength={80} className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Base URL (optional)" htmlFor="pv-url">
            <input id="pv-url" type="url" className={inputClass} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://" />
          </Field>
          <Field label="API key" htmlFor="pv-key" hint="Leave empty to keep the stored key.">
            <input id="pv-key" type="password" autoComplete="new-password" className={inputClass} value={form.apiKey} disabled={form.removeKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1">
            <Toggle label="Enabled" checked={form.enabled} onChange={(checked) => setForm({ ...form, enabled: checked })} />
            <Toggle label="Remove stored key" checked={form.removeKey} onChange={(checked) => setForm({ ...form, removeKey: checked, apiKey: '' })} />
          </div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
            <Button type="submit" variant="primary" icon={Save} busy={action.pending === 'save'}>
              Save provider
            </Button>
            <Button icon={X} onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {!data ? (
        error ? null : <Loading />
      ) : data.providers.length === 0 ? (
        <EmptyState title="No providers configured" hint="Without a provider the orchestrator runs in demo mode with mock models." />
      ) : (
        <TableWrap label="Providers">
          <thead>
            <tr>
              <th scope="col" className={th}>Provider</th>
              <th scope="col" className={th}>Kind</th>
              <th scope="col" className={th}>Base URL</th>
              <th scope="col" className={th}>API key</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Source</th>
              {isAdmin ? <th scope="col" className={th}><span className="sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {data.providers.map((provider) => (
              <tr key={provider.id}>
                <td className={td}>
                  <div className="font-medium">{provider.name}</div>
                  <div className="font-mono text-xs text-ink-2">{provider.id}</div>
                </td>
                <td className={td}>{provider.kind}</td>
                <td className={cx(td, 'break-all font-mono text-xs')}>{provider.baseUrl ?? 'Default'}</td>
                <td className={td}>{provider.hasApiKey ? 'Stored' : 'None'}</td>
                <td className={td}>
                  <StatusBadge tone={provider.enabled ? 'good' : 'muted'} label={provider.enabled ? 'Enabled' : 'Disabled'} />
                </td>
                <td className={td}>
                  <Chip>{provider.source === 'environment' ? 'Environment (read-only)' : 'Settings'}</Chip>
                </td>
                {isAdmin ? (
                  <td className={cx(td, 'whitespace-nowrap')}>
                    {provider.source === 'settings' ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Pencil}
                          aria-label={`Edit ${provider.name}`}
                          onClick={() => setForm({ id: provider.id, kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl ?? '', apiKey: '', removeKey: false, enabled: provider.enabled })}
                        >
                          Edit
                        </Button>
                        <Button size="sm" variant="danger" icon={Trash} aria-label={`Delete ${provider.name}`} busy={action.pending === `delete:${provider.id}`} onClick={() => remove(provider)}>
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersCard() {
  const { user } = useSession();
  const isAdmin = hasRole(user, 'admin');
  const isOwner = user?.role === 'owner';
  const { data, error, reload } = useApi<{ users: UserInfo[] }>(isAdmin ? '/api/users' : null);
  const action = useAction();

  const setRole = (target: UserInfo, role: UserRole) =>
    void action.run(`role:${target.id}`, async () => {
      await api(`/api/users/${encodeURIComponent(target.id)}/role`, { method: 'PATCH', body: { role } });
      await reload();
    });

  return (
    <Card title="Users and roles" description="Viewer < operator < admin < owner. Only owners can change roles.">
      {!isAdmin ? (
        <p className="text-sm text-ink-2">Listing users requires the admin role. You are signed in as {user?.role}.</p>
      ) : (
        <>
          <ErrorBanner error={error} onRetry={() => void reload()} />
          <ErrorBanner error={action.error} onDismiss={action.clearError} className="mb-3" />
          {!data ? (
            error ? null : <Loading />
          ) : data.users.length === 0 ? (
            <EmptyState title="No users" />
          ) : (
            <TableWrap label="Users">
              <thead>
                <tr>
                  <th scope="col" className={th}>User</th>
                  <th scope="col" className={th}>Role</th>
                  <th scope="col" className={th}>Last login</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td className={td}>
                      <div className="font-medium">{u.login}</div>
                      {u.name && u.name !== u.login ? <div className="text-xs text-ink-2">{u.name}</div> : null}
                    </td>
                    <td className={td}>
                      {isOwner ? (
                        <select
                          aria-label={`Role for ${u.login}`}
                          className={cx(inputClass, 'w-36')}
                          value={u.role}
                          disabled={action.pending === `role:${u.id}` || u.id === user?.id}
                          onChange={(e) => setRole(u, e.target.value as UserRole)}
                        >
                          {USER_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Chip>{u.role}</Chip>
                      )}
                      {u.id === user?.id ? <span className="ml-2 text-xs text-ink-2">(you)</span> : null}
                    </td>
                    <td className={cx(td, 'text-ink-2')}>
                      <RelativeTime value={u.lastLoginAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const { user } = useSession();
  const isAdmin = hasRole(user, 'admin');
  const models = useApi<ModelsResponse>('/api/models');

  return (
    <>
      <PageHeader title="Settings" description="Budgets, capacity, models, providers and access." />
      <div className="flex flex-col gap-6">
        <GlobalSettingsCard isAdmin={isAdmin} models={(models.data?.models ?? []).filter((m) => m.enabled)} />
        <ModelsCard isAdmin={isAdmin} models={models} />
        <ProvidersCard isAdmin={isAdmin} onChanged={() => void models.reload()} />
        <UsersCard />
      </div>
    </>
  );
}
