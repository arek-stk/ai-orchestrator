'use client';

import { FolderKanban, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ProjectStatusBadge, RunStatusBadge } from '@/components/domain';
import { hasRole, useSession } from '@/components/providers';
import { Button, Card, cx, EmptyState, ErrorBanner, Field, inputClass, Loading, PageHeader, Refreshable, TableWrap, td, textareaClass, TextLink, th } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { api, errorMessage } from '@/lib/api';
import { formatUsd, humanize } from '@/lib/format';
import { AUTONOMY_LABELS, type DomainEvent, type Project, type ProjectListItem } from '@/lib/types';

const relevant = (e: DomainEvent) => e.type.startsWith('project.') || e.type.startsWith('task.') || e.type.startsWith('pipeline.');

function BudgetBar({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const tone = pct >= 90 ? 'bg-critical' : pct >= 70 ? 'bg-warning' : 'bg-accent';
  const track = pct >= 90 ? 'bg-critical-soft' : pct >= 70 ? 'bg-warning-soft' : 'bg-accent-soft';
  return (
    <div className="min-w-[8rem]">
      <div className="tabular text-sm text-ink">
        {formatUsd(spent)} <span className="text-ink-2">/ {formatUsd(budget)}</span>
      </div>
      <div role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className={cx('mt-1 h-1.5 w-full overflow-hidden rounded-full', track)}>
        <div className={cx('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', description: '', owner: '', repoName: '', defaultBranch: 'main', priority: 5, autonomyLevel: 1, budgetUsd: 50 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const hasRepo = form.owner.trim() && form.repoName.trim();
    try {
      const { project } = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          description: form.description.trim(),
          repo: hasRepo ? { owner: form.owner.trim(), name: form.repoName.trim(), defaultBranch: form.defaultBranch.trim() || 'main' } : null,
          priority: form.priority,
          autonomyLevel: form.autonomyLevel,
          budgetUsd: form.budgetUsd,
        },
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Card title="New project" className="mb-6">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="np-name">
          <input id="np-name" required minLength={2} maxLength={120} className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Priority (1-10)" htmlFor="np-priority">
          <input id="np-priority" type="number" min={1} max={10} className={inputClass} value={form.priority} onChange={(e) => set('priority', Number(e.target.value))} />
        </Field>
        <Field label="Description" htmlFor="np-desc" className="md:col-span-2">
          <textarea id="np-desc" rows={2} maxLength={2000} className={textareaClass} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="Repository owner (optional)" htmlFor="np-owner">
          <input id="np-owner" className={inputClass} value={form.owner} onChange={(e) => set('owner', e.target.value)} placeholder="acme" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repository name" htmlFor="np-repo">
            <input id="np-repo" className={inputClass} value={form.repoName} onChange={(e) => set('repoName', e.target.value)} placeholder="webshop" />
          </Field>
          <Field label="Default branch" htmlFor="np-branch">
            <input id="np-branch" className={inputClass} value={form.defaultBranch} onChange={(e) => set('defaultBranch', e.target.value)} />
          </Field>
        </div>
        <Field label="Autonomy level" htmlFor="np-autonomy" hint="Higher levels let agents publish branches, PRs and deployments.">
          <select id="np-autonomy" className={inputClass} value={form.autonomyLevel} onChange={(e) => set('autonomyLevel', Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((level) => (
              <option key={level} value={level}>
                {level} · {AUTONOMY_LABELS[level]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Budget (USD)" htmlFor="np-budget">
          <input id="np-budget" type="number" min={0} max={100000} step="0.01" className={inputClass} value={form.budgetUsd} onChange={(e) => set('budgetUsd', Number(e.target.value))} />
        </Field>
        {error ? <ErrorBanner error={error} className="md:col-span-2" /> : null}
        <div className="flex gap-2 md:col-span-2">
          <Button type="submit" variant="primary" busy={busy}>
            Create project
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export default function ProjectsPage() {
  const { user } = useSession();
  const { data, error, refreshing, reload } = useApi<{ projects: ProjectListItem[] }>('/api/projects', { live: relevant });
  const [creating, setCreating] = useState(false);
  const isAdmin = hasRole(user, 'admin');

  const projects = [...(data?.projects ?? [])].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every repository the orchestrator manages, with status, autonomy and budget."
        actions={
          isAdmin && !creating ? (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New project
            </Button>
          ) : null
        }
      />
      {creating ? <NewProjectForm onCancel={() => setCreating(false)} /> : null}
      <ErrorBanner error={error} onRetry={() => void reload()} className="mb-6" />
      {!data ? (
        error ? null : <Loading />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet."
          hint={isAdmin ? 'Create a project to connect a repository.' : 'An admin can create the first project.'}
          action={
            isAdmin && !creating ? (
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                New project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Refreshable busy={refreshing}>
          <div className="rounded-[10px] border border-line bg-surface px-5 py-2">
            <TableWrap label="Projects">
              <thead>
                <tr>
                  <th scope="col" className={th}>Project</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}>Autonomy</th>
                  <th scope="col" className={cx(th, 'text-right')}>Priority</th>
                  <th scope="col" className={cx(th, 'text-right')}>Open tasks</th>
                  <th scope="col" className={th}>Active run</th>
                  <th scope="col" className={th}>Spent / budget</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const run = project.activeRuns[0];
                  return (
                    <tr key={project.id}>
                      <td className={td}>
                        <TextLink href={`/projects/${project.id}`} className="font-medium">
                          {project.name}
                        </TextLink>
                        <p className="mt-0.5 max-w-sm truncate text-xs text-ink-2" title={project.description}>
                          {project.repo ? `${project.repo.owner}/${project.repo.name}` : 'No repository'}
                          {project.description ? ` · ${project.description}` : ''}
                        </p>
                      </td>
                      <td className={td}>
                        <ProjectStatusBadge status={project.status} />
                      </td>
                      <td className={cx(td, 'whitespace-nowrap')}>
                        <span className="tabular text-ink-2">L{project.autonomyLevel}</span> {project.autonomyLabel}
                      </td>
                      <td className={cx(td, 'tabular text-right')}>{project.priority}</td>
                      <td className={cx(td, 'tabular text-right')}>{project.openTasks}</td>
                      <td className={td}>
                        {run ? (
                          <div className="flex flex-col items-start gap-1">
                            <TextLink href={`/runs/${run.id}`} className="whitespace-nowrap text-sm">
                              {run.currentStage ? humanize(run.currentStage) : 'Queued'}
                            </TextLink>
                            <RunStatusBadge status={run.status} />
                            {project.activeRuns.length > 1 ? <span className="text-xs text-ink-2">+{project.activeRuns.length - 1} more</span> : null}
                          </div>
                        ) : (
                          <span className="text-ink-2">None</span>
                        )}
                      </td>
                      <td className={td}>
                        <BudgetBar spent={project.spentUsd} budget={project.budgetUsd} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          </div>
        </Refreshable>
      )}
    </>
  );
}
