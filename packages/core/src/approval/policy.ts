import type { AutonomyLevel } from '../domain/enums';
import type { GatedAction } from '../domain/project';
import { isSensitivePath, matchesAnyGlob } from '../security/paths';
import { containsSecret } from '../security/secrets';

export interface ChangedFile {
  path: string;
  action: 'create' | 'update' | 'delete';
  content?: string;
}

export interface GateDetectionOptions {
  criticalPaths: readonly string[];
  largeChangeFileThreshold?: number;
  largeChangeLineThreshold?: number;
  destructiveDeleteThreshold?: number;
}

export interface DetectedGate {
  action: GatedAction;
  reason: string;
  paths: string[];
}

const MIGRATION_PATH = [/(^|\/)(migrations?|migrate)\//i, /\.sql$/i, /(^|\/)prisma\/schema\.prisma$/i, /(^|\/)drizzle\//i, /(^|\/)db\/schema\.rb$/i];
const INFRA_PATH = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(terraform|infra|infrastructure|k8s|kubernetes|helm|ansible|pulumi)\//i,
  /\.tf$/i,
  /(^|\/)Dockerfile(\.[^/]*)?$/i,
  /(^|\/)docker-compose[^/]*\.ya?ml$/i,
];
const PERMISSION_PATH = [/(^|\/)CODEOWNERS$/, /(^|\/)\.github\/settings\.ya?ml$/i];
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)|TRUNCATE\s+(TABLE\s+)?\w+|DELETE\s+FROM\s+[\w."]+)/i;

/**
 * Inspects a change set and reports actions that are gated for human approval (spec §16).
 * Detection is deliberately conservative: false positives cost a click, false negatives cost production.
 */
export function detectGatedActions(changes: readonly ChangedFile[], options: GateDetectionOptions): DetectedGate[] {
  const fileThreshold = options.largeChangeFileThreshold ?? 20;
  const lineThreshold = options.largeChangeLineThreshold ?? 1200;
  const deleteThreshold = options.destructiveDeleteThreshold ?? 5;
  const gates = new Map<GatedAction, DetectedGate>();
  const flag = (action: GatedAction, reason: string, path: string) => {
    const gate = gates.get(action) ?? { action, reason, paths: [] };
    if (!gate.paths.includes(path)) gate.paths.push(path);
    gates.set(action, gate);
  };

  let totalLines = 0;
  let deletions = 0;
  for (const change of changes) {
    const { path } = change;
    const content = change.content ?? '';
    totalLines += content.length === 0 ? 0 : content.split('\n').length;
    if (change.action === 'delete') {
      deletions++;
      if (deletions >= deleteThreshold) flag('destructive_data', `${deletions} files deleted`, path);
    }
    if (MIGRATION_PATH.some((re) => re.test(path))) flag('database_migration', 'Database schema or migration changed', path);
    if (DESTRUCTIVE_SQL.test(content)) flag('destructive_data', 'Destructive SQL statement', path);
    if (INFRA_PATH.some((re) => re.test(path)) || matchesAnyGlob(path, options.criticalPaths)) {
      flag('critical_infrastructure', 'Critical infrastructure or CI configuration changed', path);
    }
    if (isSensitivePath(path) || PERMISSION_PATH.some((re) => re.test(path))) {
      flag('secrets_permissions', 'Secrets or permission configuration touched', path);
    }
    if (content.length > 0 && containsSecret(content)) flag('secrets_permissions', 'Change set contains a secret-looking value', path);
  }

  if (changes.length >= fileThreshold || totalLines >= lineThreshold) {
    gates.set('architecture_change', {
      action: 'architecture_change',
      reason: `Large change: ${changes.length} files / ${totalLines} lines`,
      paths: changes.slice(0, 20).map((c) => c.path),
    });
  }
  return [...gates.values()];
}

export interface ApprovalRequirementInput {
  action: GatedAction;
  autonomyLevel: AutonomyLevel;
  gates: Readonly<Record<GatedAction, boolean>>;
}

/** Production deployments below level 4 always need a human, regardless of gate configuration. */
export function requiresApproval(input: ApprovalRequirementInput): boolean {
  if (input.action === 'production_deploy' && input.autonomyLevel < 4) return true;
  return input.gates[input.action];
}

export function requiresCostApproval(estimatedCostUsd: number, thresholdUsd: number, gates: Readonly<Record<GatedAction, boolean>>): boolean {
  return gates.high_cost && thresholdUsd > 0 && estimatedCostUsd >= thresholdUsd;
}
