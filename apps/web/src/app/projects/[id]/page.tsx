'use client';

import { ExternalLink, Pause, Play } from 'lucide-react';
import { useParams, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProjectStatusBadge } from '@/components/domain';
import { useBreadcrumb } from '@/components/shell';
import { ProjectSettingsTab } from '@/components/project-settings';
import { AgentsTab, CostsTab, DecisionsTab, GitHubTab, LogsTab, OverviewTab, PipelineTab, TasksTab, TestsTab } from '@/components/project-tabs';
import { hasRole, useSession } from '@/components/providers';
import { Button, Chip, ErrorBanner, GitHubMark, Loading, PageHeader, Refreshable, TabPanel, Tabs, TextLink } from '@/components/ui';
import { useAction, useApi } from '@/hooks/use-api';
import { api } from '@/lib/api';
import type { ProjectDetailResponse } from '@/lib/types';

const TAB_IDS = ['overview', 'pipeline', 'tasks', 'agents', 'github', 'tests', 'logs', 'decisions', 'costs', 'settings'] as const;
type TabId = (typeof TAB_IDS)[number];

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? '');
  const pathname = usePathname();
  const { user } = useSession();
  const [tab, setTab] = useState<TabId>('overview');
  const detail = useApi<ProjectDetailResponse>(id ? `/api/projects/${encodeURIComponent(id)}` : null, {
    live: (event) => event.projectId === id && event.type !== 'scheduler.tick',
  });
  const action = useAction();
  useBreadcrumb(detail.data ? [{ label: 'Projects', href: '/projects' }, { label: detail.data.project.name }] : null);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested && (TAB_IDS as readonly string[]).includes(requested)) setTab(requested as TabId);
  }, []);

  const changeTab = (next: string) => {
    setTab(next as TabId);
    window.history.replaceState(null, '', next === 'overview' ? pathname : `${pathname}?tab=${next}`);
  };

  const data = detail.data;
  if (!data) {
    return (
      <>
        <ErrorBanner error={detail.error} onRetry={() => void detail.reload()} />
        {detail.error ? null : <Loading label="Loading project" />}
      </>
    );
  }

  const { project } = data;
  const openTasks = data.tasks.filter((t) => !['DONE', 'FAILED', 'CANCELLED'].includes(t.status)).length;
  const canOperate = hasRole(user, 'operator');
  const paused = project.status === 'PAUSED';

  const togglePause = () =>
    void action.run('pause', async () => {
      await api(`/api/projects/${encodeURIComponent(project.id)}/${paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} });
      await detail.reload();
    });

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'pipeline', label: 'Pipeline', count: data.runs.length },
    { id: 'tasks', label: 'Tasks', count: openTasks },
    { id: 'agents', label: 'Agents' },
    { id: 'github', label: 'GitHub' },
    { id: 'tests', label: 'Tests' },
    { id: 'logs', label: 'Logs' },
    { id: 'decisions', label: 'Decisions', count: data.decisions.length },
    { id: 'costs', label: 'Costs' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <div className="flex flex-col gap-2">
            {project.description ? <p>{project.description}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <ProjectStatusBadge status={project.status} />
              <Chip title="Autonomy level">
                <span className="tabular">L{project.autonomyLevel}</span> {project.autonomyLabel}
              </Chip>
              <Chip title="Priority">Priority {project.priority}</Chip>
              {project.repo ? (
                <a
                  href={`https://github.com/${project.repo.owner}/${project.repo.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-link hover:underline"
                >
                  <GitHubMark size={12} className="text-ink" />
                  {project.repo.owner}/{project.repo.name}
                  <ExternalLink aria-hidden="true" size={11} />
                  <span className="sr-only">(opens GitHub)</span>
                </a>
              ) : (
                <Chip>No repository</Chip>
              )}
            </div>
          </div>
        }
        actions={
          canOperate ? (
            <Button icon={paused ? Play : Pause} busy={action.pending === 'pause'} onClick={togglePause}>
              {paused ? 'Resume project' : 'Pause project'}
            </Button>
          ) : null
        }
      />
      <ErrorBanner error={action.error} onDismiss={action.clearError} className="mb-4" />
      <ErrorBanner error={detail.error} onRetry={() => void detail.reload()} className="mb-4" />

      <Tabs tabs={tabs} active={tab} onChange={changeTab} idPrefix="project" label="Project sections" />
      <Refreshable busy={detail.refreshing}>
        <TabPanel idPrefix="project" id={tab}>
          {tab === 'overview' ? <OverviewTab detail={data} /> : null}
          {tab === 'pipeline' ? <PipelineTab detail={data} /> : null}
          {tab === 'tasks' ? <TasksTab detail={data} reload={detail.reload} /> : null}
          {tab === 'agents' ? <AgentsTab projectId={project.id} /> : null}
          {tab === 'github' ? <GitHubTab detail={data} /> : null}
          {tab === 'tests' ? <TestsTab detail={data} /> : null}
          {tab === 'logs' ? <LogsTab projectId={project.id} /> : null}
          {tab === 'decisions' ? <DecisionsTab detail={data} /> : null}
          {tab === 'costs' ? <CostsTab projectId={project.id} /> : null}
          {tab === 'settings' ? <ProjectSettingsTab project={project} reload={detail.reload} /> : null}
        </TabPanel>
      </Refreshable>
    </>
  );
}
