// German labels, tones and derived figures for the Workflows UI. Pure functions, unit tested.

import type { AgentRole, WorkflowEventRecord, WorkflowNode, WorkflowRunStatus, WorkflowStep, WorkflowStepStatus } from './types';

export type WorkflowTone = 'good' | 'accent' | 'warning' | 'critical' | 'muted';

export const RUN_STATUS: Record<WorkflowRunStatus, { label: string; tone: WorkflowTone }> = {
  queued: { label: 'In Warteschlange', tone: 'muted' },
  running: { label: 'Läuft', tone: 'accent' },
  succeeded: { label: 'Abgeschlossen', tone: 'good' },
  partial: { label: 'Teilweise abgeschlossen', tone: 'warning' },
  failed: { label: 'Fehlgeschlagen', tone: 'critical' },
  blocked: { label: 'Blockiert', tone: 'critical' },
  cancelled: { label: 'Abgebrochen', tone: 'muted' },
};

export const STEP_STATUS: Record<WorkflowStepStatus, { label: string; tone: WorkflowTone }> = {
  pending: { label: 'Wartet', tone: 'muted' },
  running: { label: 'In Bearbeitung', tone: 'accent' },
  succeeded: { label: 'Abgeschlossen', tone: 'good' },
  failed: { label: 'Fehlgeschlagen', tone: 'critical' },
  skipped: { label: 'Übersprungen', tone: 'warning' },
  blocked: { label: 'Blockiert', tone: 'critical' },
  cancelled: { label: 'Abgebrochen', tone: 'muted' },
};

export const WORKFLOW_STATUS_LABELS = { active: 'Aktiv', draft: 'Entwurf', archived: 'Archiviert' } as const;

export const ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator',
  project_analyst: 'Analyse',
  planner: 'Strategie & Planung',
  architect: 'Architektur',
  builder: 'Umsetzung',
  frontend: 'Gestaltung',
  backend: 'Backend',
  database: 'Datenbank',
  security: 'Sicherheit',
  tester: 'Test',
  debugger: 'Fehleranalyse',
  reviewer: 'Review',
  researcher: 'Recherche',
  documentation: 'Texte & Dokumentation',
  devops: 'DevOps',
  release: 'Release',
};

export const NODE_TYPE_LABELS: Record<WorkflowNode['type'], string> = {
  goal: 'Ziel',
  orchestrator: 'KI-Orchestrator',
  agent: 'Agent',
  join: 'Zusammenführung',
  finale: 'Finale',
};

export const FORMAT_LABELS = { markdown: 'Markdown', text: 'Text', json: 'JSON' } as const;

/** Accent colours that keep contrast on the dark reference look and in light mode. */
export const ACCENTS = ['#14b8a6', '#3b82f6', '#a855f7', '#f59e0b', '#f43f5e', '#0ea5e9', '#22c55e', '#e879f9'] as const;

const TOOL_ACCENT: Record<string, string> = {
  perplexity: '#14b8a6',
  claude: '#3b82f6',
  chatgpt: '#a855f7',
  midjourney: '#f59e0b',
  runway: '#f43f5e',
  elevenlabs: '#0ea5e9',
  gemini: '#22c55e',
};

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return value;
}

export function nodeAccent(node: WorkflowNode): string {
  switch (node.type) {
    case 'goal':
      return '#8b5cf6';
    case 'orchestrator':
      return '#6366f1';
    case 'join':
      return '#06b6d4';
    case 'finale':
      return '#14b8a6';
    case 'agent':
      return TOOL_ACCENT[node.toolId] ?? ACCENTS[hash(node.toolId) % ACCENTS.length]!;
  }
}

export interface RunProgress {
  done: number;
  total: number;
  /** 0–1 */
  ratio: number;
  /** Estimated remaining milliseconds from measured step durations; null until one step with a duration finished. */
  remainingMs: number | null;
}

const TERMINAL: ReadonlySet<WorkflowStepStatus> = new Set(['succeeded', 'failed', 'skipped', 'blocked', 'cancelled']);

export function runProgress(steps: readonly WorkflowStep[], now: number = Date.now()): RunProgress {
  const total = steps.length;
  const done = steps.filter((s) => TERMINAL.has(s.status)).length;
  const durations = steps
    .filter((s) => s.status === 'succeeded' && s.startedAt && s.finishedAt && s.nodeType === 'agent')
    .map((s) => new Date(s.finishedAt!).getTime() - new Date(s.startedAt!).getTime())
    .filter((ms) => ms >= 0);
  let remainingMs: number | null = null;
  const open = steps.filter((s) => !TERMINAL.has(s.status) && s.nodeType === 'agent');
  if (durations.length > 0) {
    const average = durations.reduce((a, b) => a + b, 0) / durations.length;
    remainingMs = open.reduce((sum, step) => {
      if (step.status === 'running' && step.startedAt) return sum + Math.max(0, average - (now - new Date(step.startedAt).getTime()));
      return sum + average;
    }, 0);
  }
  return { done, total, ratio: total === 0 ? 0 : done / total, remainingMs };
}

export function formatRemaining(ms: number | null): string {
  if (ms === null) return 'Noch keine Schätzung';
  if (ms < 60_000) return '< 1 min';
  return `~ ${Math.round(ms / 60_000)} min`;
}

export function formatClock(value: string | null): string {
  if (!value) return '–';
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

export interface LogLine {
  key: string;
  at: string | null;
  nodeId: string;
  label: string;
  status: WorkflowStepStatus;
  text: string;
}

/** Ausführung tab: one line per step that started or ended, ordered by time. */
export function stepLog(steps: readonly WorkflowStep[], nodes: readonly WorkflowNode[]): LogLine[] {
  const labels = new Map(nodes.map((n) => [n.id, n.label]));
  return steps
    .filter((s) => s.status !== 'pending')
    .map((s) => ({
      key: s.id,
      at: s.finishedAt ?? s.startedAt,
      nodeId: s.nodeId,
      label: labels.get(s.nodeId) ?? s.nodeId,
      status: s.status,
      text: s.summary ?? s.reason ?? STEP_STATUS[s.status].label,
    }))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.label.localeCompare(b.label));
}

const EVENT_LABELS: Record<string, string> = {
  'workflow.run.created': 'Lauf angelegt',
  'workflow.run.started': 'Lauf gestartet',
  'workflow.run.finished': 'Lauf beendet',
  'workflow.step.updated': 'Schritt aktualisiert',
};

/** Protokoll tab: detailed event lines. */
export function describeEvent(event: WorkflowEventRecord, labels: ReadonlyMap<string, string>): string {
  const base = EVENT_LABELS[event.type] ?? event.type;
  const { payload } = event;
  if (event.type === 'workflow.step.updated' && payload.nodeId) {
    const status = STEP_STATUS[payload.status as WorkflowStepStatus]?.label ?? payload.status ?? '';
    return `${labels.get(payload.nodeId) ?? payload.nodeId}: ${status}`;
  }
  if (event.type === 'workflow.run.finished' && payload.status) return `${base}: ${RUN_STATUS[payload.status as WorkflowRunStatus]?.label ?? payload.status}`;
  if (event.type === 'workflow.run.created' && payload.status) return `${base} (${RUN_STATUS[payload.status as WorkflowRunStatus]?.label ?? payload.status}${payload.mode === 'demo' ? ', Demo' : ''})`;
  return base;
}

export function isActiveRun(status: WorkflowRunStatus | undefined): boolean {
  return status === 'queued' || status === 'running';
}
