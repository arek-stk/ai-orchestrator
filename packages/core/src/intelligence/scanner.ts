import { AGENT_DEFINITIONS, type AgentInput } from '../agents/definitions';
import type { AgentRuntime } from '../agents/runtime';
import type { ProposalItem } from '../agents/schemas';
import type { ContextFile, IndexedFile } from '../context/context-builder';
import { summarizeFiles, type FileSummaryStore } from '../context/file-summarizer';
import { TERMINAL_TASK_STATUSES } from '../domain/enums';
import type { Project } from '../domain/project';
import type { Task } from '../domain/task';
import type { GitHubPort } from '../github/port';
import { estimateTokens } from '../models/registry';
import type { Clock, EventRecorder, JobQueue, MemoryRepository, ProjectRepository, RunRepository, TaskRepository } from '../ports';
import type { RepoFileStore, RepoIndexer } from '../repo-index/indexer';
import { normalizeRepoPath } from '../security/paths';
import { heuristicProposals, isAutoAcceptable, proposalTaskInput, scoreProposal, type ScoredProposal } from './proposals';
import { collectSignals, computeHealthScore, selectManifests } from './signals';
import type { HealthScan, HealthScanRepository, HealthScanTrigger, HealthSignals, ImprovementProposal, ProposalRepository } from './types';

export const HEALTH_SCAN_JOB = 'project.health_scan';

export interface HealthScannerDeps {
  projects: ProjectRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  memories: MemoryRepository;
  scans: HealthScanRepository;
  proposals: ProposalRepository;
  events: EventRecorder;
  queue: JobQueue;
  clock: Clock;
  runtime: AgentRuntime;
  github: GitHubPort;
  repoIndex: RepoIndexer;
  repoFiles: RepoFileStore;
  /** When present, the scan fills missing file summaries (bounded) before asking the scan agent. */
  summaries?: FileSummaryStore;
}

export interface HealthScannerOptions {
  /** Hard cap on model spend per scan, on top of global and project budgets. */
  maxScanCostUsd: number;
  maxProposals: number;
  maxAutoAcceptPerScan: number;
  /** Auto-accepted improvement tasks that may be open at once per project. */
  maxOpenAutoTasks: number;
  summaryBatches: number;
  recentRuns: number;
  maxManifestBytes: number;
  maxDevOpsFiles: number;
}

export const DEFAULT_HEALTH_SCANNER_OPTIONS: Readonly<HealthScannerOptions> = Object.freeze({
  maxScanCostUsd: 1,
  maxProposals: 20,
  maxAutoAcceptPerScan: 3,
  maxOpenAutoTasks: 5,
  summaryBatches: 1,
  recentRuns: 50,
  maxManifestBytes: 200_000,
  maxDevOpsFiles: 3,
});

export interface Actor {
  /** User id for task authorship; null for the system. */
  userId: string | null;
  name: string;
}

const SYSTEM: Actor = { userId: null, name: 'system' };

function scanTask(title: string, goal: string): AgentInput['task'] {
  return { title, goal, kind: 'improvement', risk: 'low', estimatedComplexity: 'medium', acceptanceCriteria: [] };
}

function compactSignals(signals: HealthSignals): string {
  return JSON.stringify(
    {
      ...signals,
      failures: signals.failures.map((f) => ({ ...f, summary: f.summary.slice(0, 200) })),
      blockedTasks: signals.blockedTasks.map((t) => ({ title: t.title, reason: t.reason?.slice(0, 200) ?? null })),
    },
    null,
    1,
  ).slice(0, 12_000);
}

/**
 * Project Health Scan (spec §14): deterministic signals and score, heuristic proposals, at most one scan-agent and one
 * DevOps call, ROI-ranked proposals, and auto-acceptance only for small low-risk improvements at autonomy level ≥ 3.
 * One scan is one bounded job; a budget pause degrades to a heuristics-only scan instead of failing.
 */
export class HealthScanner {
  readonly options: HealthScannerOptions;

  constructor(
    private readonly deps: HealthScannerDeps,
    options: Partial<HealthScannerOptions> = {},
  ) {
    this.options = { ...DEFAULT_HEALTH_SCANNER_OPTIONS, ...options };
  }

  /** Queues a scan unless one is already queued or running for the project. */
  async request(projectId: string, trigger: HealthScanTrigger, requestedBy: string | null): Promise<{ scan: HealthScan; created: boolean }> {
    // Atomic in the store: concurrent requests (API, scheduler) get the same active scan and only one job is queued.
    const { scan, created } = await this.deps.scans.create({ projectId, trigger, requestedBy });
    if (!created) return { scan, created: false };
    await this.deps.queue.enqueue({ type: HEALTH_SCAN_JOB, payload: { scanId: scan.id }, dedupeKey: `health-scan:${projectId}`, maxAttempts: 2 });
    await this.deps.events.emit({ type: 'project.health_scan.requested', projectId, taskId: null, runId: null, payload: { scanId: scan.id, trigger } });
    return { scan, created: true };
  }

  /** Queues scheduled scans for projects whose last scan is older than `intervalMs`. Level 0 projects are only scanned on request. */
  async scheduleDue(intervalMs: number): Promise<number> {
    const now = this.deps.clock.now().getTime();
    let queued = 0;
    for (const project of await this.deps.projects.list()) {
      if (project.autonomyLevel < 1 || !project.repo || project.status === 'PAUSED') continue;
      const [latest] = await this.deps.scans.list(project.id, 1);
      if (latest && now - latest.createdAt.getTime() < intervalMs) continue;
      if ((await this.request(project.id, 'scheduled', null)).created) queued++;
    }
    return queued;
  }

  async run(scanId: string): Promise<HealthScan | null> {
    const scan = await this.deps.scans.get(scanId);
    if (!scan || scan.status === 'completed' || scan.status === 'failed') return scan;
    const project = await this.deps.projects.get(scan.projectId);
    if (!project) return this.deps.scans.update(scanId, { status: 'failed', error: 'project no longer exists', finishedAt: this.deps.clock.now() });

    await this.deps.scans.update(scanId, { status: 'running', startedAt: this.deps.clock.now() });
    try {
      return await this.execute(scan, project);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      await this.deps.events.emit({ type: 'project.health_scan.failed', projectId: project.id, taskId: null, runId: null, payload: { scanId, error: message } });
      return this.deps.scans.update(scanId, { status: 'failed', error: message, finishedAt: this.deps.clock.now() });
    }
  }

  private async execute(scan: HealthScan, project: Project): Promise<HealthScan> {
    const { deps, options } = this;
    const base = { projectId: project.id, taskId: null, runId: null };

    // 1. Deterministic signals.
    let files: IndexedFile[] = [];
    let headSha: string | null = null;
    if (project.repo) {
      const index = await deps.repoIndex.refresh(project.id, project.repo, project.repo.defaultBranch);
      files = index.files;
      headSha = index.headSha;
    }
    const load = async (path: string, maxBytes: number): Promise<string | null> => {
      if (!project.repo || !headSha) return null;
      const content = await deps.github.getFileContent(project.repo, path, headSha);
      return content === null ? null : content.slice(0, maxBytes);
    };

    const manifests: Array<{ path: string; content: string }> = [];
    for (const path of selectManifests(files)) {
      const content = await load(path, options.maxManifestBytes);
      if (content !== null) manifests.push({ path, content });
    }
    const [failures, runs, blockedTasks] = await Promise.all([
      deps.memories.search(project.id, { scope: 'failure', limit: 20 }),
      deps.runs.list({ projectId: project.id, limit: options.recentRuns }),
      deps.tasks.list({ projectId: project.id, statuses: ['BLOCKED'], limit: 20 }),
    ]);
    const signals = collectSignals({ files, manifests, failures, runs, blockedTasks });
    const { score, breakdown } = computeHealthScore(signals);

    // 2. Model-assisted findings, bounded by the scan budget.
    let costUsd = 0;
    const remaining = () => Math.max(0, options.maxScanCostUsd - costUsd);
    const agentNotes: string[] = [];
    const heuristics = heuristicProposals(signals);
    const scored: ScoredProposal[] = heuristics.map((p) => scoreProposal(p, 'heuristic'));
    let agentSummary: string | null = null;

    if (deps.summaries && project.repo && files.length > 0) {
      const summarized = await summarizeFiles({
        runtime: deps.runtime,
        store: deps.summaries,
        project,
        files,
        loadContent: (path) => load(path, 400_000),
        scope: base,
        priorityPaths: signals.untestedModules.map((m) => m.path),
        maxBatches: options.summaryBatches,
        runBudgetRemainingUsd: remaining(),
      });
      costUsd += summarized.costUsd;
      files = files.map((f) => (summarized.summaries.has(f.path) ? { ...f, summary: summarized.summaries.get(f.path)! } : f));
      if (summarized.stoppedBecause) agentNotes.push(`summaries stopped: ${summarized.stoppedBecause}`);
    }

    const knownPaths = new Set(files.map((f) => f.path));
    const grounded = (item: ProposalItem): ProposalItem => ({
      ...item,
      // Models must not invent files: keep only safe paths that exist in the index.
      affectedPaths: item.affectedPaths.filter((path) => {
        try {
          return knownPaths.size === 0 || knownPaths.has(normalizeRepoPath(path));
        } catch {
          return false;
        }
      }),
    });

    let agentStatus: string;
    if (remaining() <= 0) {
      agentStatus = 'skipped: scan budget exhausted';
    } else {
      const summaries = files.filter((f) => f.summary).slice(0, 40).map((f) => `- ${f.path}: ${f.summary}`).join('\n');
      const outcome = await deps.runtime.run({
        definition: AGENT_DEFINITIONS.health_scan,
        input: {
          project: { name: project.name, description: project.description, languages: project.profile.languages },
          task: scanTask('Project health scan', 'Find the most valuable, well-grounded improvements for this project.'),
          sections: [
            { title: 'Health score', body: `${score}/100\n${breakdown.map((b) => `- ${b.component}: -${b.penalty} (${b.detail})`).join('\n')}` },
            { title: 'Signals', body: compactSignals(signals) },
            { title: 'Heuristic findings (do not repeat)', body: heuristics.map((h) => `- [${h.category}] ${h.title}`).join('\n') || '(none)' },
            ...(summaries ? [{ title: 'File summaries', body: summaries }] : []),
          ],
          files: [],
        },
        scope: base,
        complexity: 'medium',
        risk: 'low',
        projectRoleOverrides: project.settings.modelOverrides,
        runBudgetRemainingUsd: remaining(),
      });
      costUsd += outcome.costUsd;
      if (outcome.ok) {
        agentStatus = outcome.cached ? 'cached' : 'ok';
        agentSummary = outcome.output.summary;
        scored.push(...outcome.output.proposals.map((p) => scoreProposal(grounded(p), 'agent')));
      } else {
        agentStatus = outcome.kind === 'budget_paused' ? 'skipped: budget' : `failed: ${outcome.kind}`;
      }
    }

    const devopsPaths = [...signals.ci.workflows, ...signals.ci.dockerfiles].slice(0, options.maxDevOpsFiles);
    if (devopsPaths.length > 0 && remaining() > 0 && !agentStatus.startsWith('skipped')) {
      const devopsFiles: ContextFile[] = [];
      for (const path of devopsPaths) {
        const content = await load(path, 20_000);
        if (content !== null) devopsFiles.push({ path, mode: 'full', content, tokens: estimateTokens(content), reasons: ['CI/container configuration'] });
      }
      if (devopsFiles.length > 0) {
        const outcome = await deps.runtime.run({
          definition: AGENT_DEFINITIONS.devops_review,
          input: {
            project: { name: project.name, description: project.description, languages: project.profile.languages },
            task: scanTask('CI and container review', 'Suggest improvements for CI, containers and deployment configuration.'),
            sections: [{ title: 'Project profile', body: JSON.stringify({ hasCi: project.profile.hasCi, deployWorkflow: project.profile.deployWorkflow, commands: Object.keys(project.profile.commands) }) }],
            files: devopsFiles,
          },
          scope: base,
          complexity: 'simple',
          risk: 'low',
          projectRoleOverrides: project.settings.modelOverrides,
          runBudgetRemainingUsd: remaining(),
        });
        costUsd += outcome.costUsd;
        if (outcome.ok) scored.push(...outcome.output.suggestions.map(({ area, ...p }) => scoreProposal(grounded({ ...p, evidence: [`area: ${area}`, ...p.evidence].slice(0, 10) }), 'devops')));
        else agentNotes.push(`devops: ${outcome.kind}`);
      }
    }

    // 3. Persist ROI-ranked proposals (deduplicated by fingerprint) and auto-accept within the guardrails.
    const unique = new Map<string, ScoredProposal>();
    for (const proposal of scored) if (!unique.has(proposal.fingerprint)) unique.set(proposal.fingerprint, proposal);
    const ranked = [...unique.values()].sort((a, b) => b.priority - a.priority || b.roiScore - a.roiScore).slice(0, options.maxProposals);

    let openAutoTasks = await this.openAutoTaskCount(project.id);
    let created = 0;
    let autoAccepted = 0;
    for (const item of ranked) {
      const { proposal, created: isNew } = await deps.proposals.upsert({
        projectId: project.id,
        scanId: scan.id,
        fingerprint: item.fingerprint,
        category: item.category,
        title: item.title,
        description: item.description,
        rationale: item.rationale,
        evidence: item.evidence,
        affectedPaths: item.affectedPaths,
        acceptanceCriteria: item.acceptanceCriteria,
        impact: item.impact,
        effort: item.effort,
        risk: item.risk,
        roiScore: item.roiScore,
        priority: item.priority,
        source: item.source,
      });
      if (isNew) {
        created++;
        await deps.events.emit({ type: 'improvement.proposed', ...base, payload: { proposalId: proposal.id, title: proposal.title, category: proposal.category, priority: proposal.priority } });
      }
      const canAutoAccept =
        proposal.status === 'proposed' &&
        isAutoAcceptable(proposal, project.autonomyLevel) &&
        autoAccepted < options.maxAutoAcceptPerScan &&
        openAutoTasks < options.maxOpenAutoTasks;
      if (canAutoAccept && (await this.accept(proposal.id, SYSTEM, true))) {
        autoAccepted++;
        openAutoTasks++;
      }
    }

    // 4. Score, history and memory.
    const [previous] = (await deps.scans.list(project.id, 5)).filter((s) => s.id !== scan.id && s.status === 'completed');
    await deps.projects.update(project.id, { healthScore: score });
    await deps.memories.upsert({
      projectId: project.id,
      scope: 'project',
      kind: 'health',
      key: 'health:latest',
      content: JSON.stringify({ score, breakdown: breakdown.filter((b) => b.penalty > 0), topProposals: ranked.slice(0, 5).map((p) => p.title) }),
      tags: ['health'],
    });
    const summary = [agentSummary ?? `Heuristic scan: ${ranked.length} proposal(s).`, ...agentNotes].join(' ').slice(0, 3000);
    const completed = await deps.scans.update(scan.id, {
      status: 'completed',
      healthScore: score,
      previousScore: previous?.healthScore ?? null,
      breakdown,
      signals,
      proposalsCreated: created,
      proposalsSeen: ranked.length,
      autoAccepted,
      agentStatus,
      costUsd,
      summary,
      finishedAt: deps.clock.now(),
    });
    await deps.events.emit({
      type: 'project.health_scanned',
      ...base,
      payload: { scanId: scan.id, healthScore: score, previousScore: completed.previousScore, proposalsCreated: created, autoAccepted, costUsd },
    });
    return completed;
  }

  /** Turns a proposal into a BACKLOG task. Returns null when the proposal is missing or already decided. */
  async accept(proposalId: string, actor: Actor, auto = false): Promise<{ proposal: ImprovementProposal; task: Task } | null> {
    const proposal = await this.deps.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'proposed') return null;
    const created = await this.deps.tasks.create(proposal.projectId, proposalTaskInput(proposal), actor.userId);
    const task = await this.deps.tasks.update(created.id, { status: 'BACKLOG' });
    const accepted = await this.deps.proposals.accept(proposal.id, { taskId: task.id, decidedBy: actor.name, auto });
    if (!accepted) {
      // Someone decided concurrently; the task must not survive without its proposal.
      await this.deps.tasks.update(task.id, { status: 'CANCELLED', blockedReason: 'improvement proposal was decided concurrently' });
      return null;
    }
    const base = { projectId: proposal.projectId, taskId: task.id, runId: null };
    await this.deps.events.emit({ type: 'task.created', ...base, payload: { title: task.title } });
    await this.deps.events.emit({ type: 'improvement.accepted', ...base, payload: { proposalId: proposal.id, taskId: task.id, auto, by: actor.name } });
    return { proposal: accepted, task };
  }

  async dismiss(proposalId: string, actor: Actor, reason: string | null): Promise<ImprovementProposal | null> {
    const dismissed = await this.deps.proposals.dismiss(proposalId, { decidedBy: actor.name, reason });
    if (dismissed) {
      await this.deps.events.emit({ type: 'improvement.dismissed', projectId: dismissed.projectId, taskId: null, runId: null, payload: { proposalId, by: actor.name, reason } });
    }
    return dismissed;
  }

  private async openAutoTaskCount(projectId: string): Promise<number> {
    const accepted = (await this.deps.proposals.list({ projectId, statuses: ['accepted'], limit: 500 })).filter((p) => p.autoAccepted && p.taskId);
    if (accepted.length === 0) return 0;
    const statuses = await this.deps.tasks.statuses(accepted.map((p) => p.taskId!));
    return [...statuses.values()].filter((status) => !TERMINAL_TASK_STATUSES.has(status)).length;
  }
}
