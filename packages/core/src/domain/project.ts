import { z } from 'zod';
import { AGENT_ROLES, type AgentRole, type AutonomyLevel, type ProjectStatus } from './enums';

export const GATED_ACTIONS = [
  'production_deploy',
  'database_migration',
  'destructive_data',
  'architecture_change',
  'secrets_permissions',
  'high_cost',
  'external_service',
  'critical_infrastructure',
  'dependency_addition',
] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

/** Gates that no autonomy level and no project gate configuration can switch off (ADR-031). */
export const HARD_GATED_ACTIONS: readonly GatedAction[] = Object.freeze(['dependency_addition'] as const);

export interface StopConditions {
  maxIterations: number;
  maxCostUsd: number;
  maxTokens: number;
  maxRuntimeMs: number;
  maxDebugAttempts: number;
}

export interface CouncilSettings {
  maxRounds: number;
  confidenceThreshold: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface ProjectChecks {
  build: boolean;
  test: boolean;
  lint: boolean;
  typecheck: boolean;
  security: boolean;
  dependencies: boolean;
  e2e: boolean;
  performance: boolean;
  accessibility: boolean;
  api: boolean;
  database: boolean;
}

export const PROJECT_COMMANDS = ['install', 'build', 'test', 'lint', 'typecheck', 'e2e'] as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number];

/** Describes what "verified" means for this project (spec §13). */
export interface ProjectProfile {
  languages: string[];
  checks: ProjectChecks;
  /** Allow-listed sandbox commands. Agents can never supply their own. */
  commands: Partial<Record<ProjectCommand, string>>;
  hasCi: boolean;
  /** GitHub Actions workflow file used for deployments, e.g. "deploy.yml". */
  deployWorkflow: string | null;
  /** Globs that count as critical infrastructure and always need approval when touched. */
  criticalPaths: string[];
  /** Branch globs the orchestrator must never write to (default branch is always protected). */
  protectedBranches: string[];
}

export interface ProjectSettings {
  stopConditions: StopConditions;
  council: CouncilSettings;
  approvalGates: Record<GatedAction, boolean>;
  highCostThresholdUsd: number;
  maxConcurrentTasks: number;
  /** Agent role → model registry id. Overrides automatic routing for this project. */
  modelOverrides: Partial<Record<AgentRole, string>>;
}

export interface RepoRef {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  repo: RepoRef | null;
  status: ProjectStatus;
  priority: number;
  autonomyLevel: AutonomyLevel;
  healthScore: number;
  budgetUsd: number;
  spentUsd: number;
  tokensUsed: number;
  profile: ProjectProfile;
  settings: ProjectSettings;
  lastScheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_STOP_CONDITIONS: Readonly<StopConditions> = Object.freeze({
  maxIterations: 12,
  maxCostUsd: 5,
  maxTokens: 1_500_000,
  maxRuntimeMs: 2 * 60 * 60 * 1000,
  maxDebugAttempts: 3,
});

export const DEFAULT_COUNCIL_SETTINGS: Readonly<CouncilSettings> = Object.freeze({
  maxRounds: 2,
  confidenceThreshold: 0.8,
  maxTokens: 120_000,
  timeoutMs: 180_000,
});

export function defaultApprovalGates(): Record<GatedAction, boolean> {
  return {
    production_deploy: true,
    database_migration: true,
    destructive_data: true,
    architecture_change: true,
    secrets_permissions: true,
    high_cost: true,
    external_service: true,
    critical_infrastructure: true,
    dependency_addition: true,
  };
}

export function defaultProjectProfile(): ProjectProfile {
  return {
    languages: [],
    checks: {
      build: true,
      test: true,
      lint: true,
      typecheck: true,
      security: true,
      dependencies: true,
      e2e: false,
      performance: false,
      accessibility: false,
      api: false,
      database: false,
    },
    commands: {},
    hasCi: true,
    deployWorkflow: null,
    criticalPaths: [],
    protectedBranches: [],
  };
}

export function defaultProjectSettings(): ProjectSettings {
  return {
    stopConditions: { ...DEFAULT_STOP_CONDITIONS },
    council: { ...DEFAULT_COUNCIL_SETTINGS },
    approvalGates: defaultApprovalGates(),
    highCostThresholdUsd: 2,
    maxConcurrentTasks: 2,
    modelOverrides: {},
  };
}

// ---------------------------------------------------------------------------
// Input validation (API boundary)
// ---------------------------------------------------------------------------

export const RepoRefSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'invalid GitHub owner'),
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, 'invalid repository name')
    .refine((n) => n !== '.' && n !== '..', 'invalid repository name'),
  defaultBranch: z.string().min(1).max(255).default('main'),
});

export const StopConditionsSchema = z.object({
  maxIterations: z.number().int().min(1).max(100),
  maxCostUsd: z.number().positive().max(10_000),
  maxTokens: z.number().int().positive().max(100_000_000),
  maxRuntimeMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000),
  maxDebugAttempts: z.number().int().min(0).max(10),
});

export const CouncilSettingsSchema = z.object({
  maxRounds: z.number().int().min(1).max(5),
  confidenceThreshold: z.number().min(0.5).max(1),
  maxTokens: z.number().int().positive().max(5_000_000),
  timeoutMs: z.number().int().min(10_000).max(60 * 60 * 1000),
});

const GLOB = z.string().min(1).max(300);

export const ProjectProfileSchema = z.object({
  languages: z.array(z.string().min(1).max(40)).max(20),
  checks: z.object({
    build: z.boolean(),
    test: z.boolean(),
    lint: z.boolean(),
    typecheck: z.boolean(),
    security: z.boolean(),
    dependencies: z.boolean(),
    e2e: z.boolean(),
    performance: z.boolean(),
    accessibility: z.boolean(),
    api: z.boolean(),
    database: z.boolean(),
  }),
  commands: z.partialRecord(z.enum(['install', 'build', 'test', 'lint', 'typecheck', 'e2e']), z.string().min(1).max(500)),
  hasCi: z.boolean(),
  deployWorkflow: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\.ya?ml$/, 'workflow must be a file name like deploy.yml')
    .nullable(),
  criticalPaths: z.array(GLOB).max(100),
  protectedBranches: z.array(GLOB).max(50),
});

export const ProjectSettingsSchema = z.object({
  stopConditions: StopConditionsSchema,
  council: CouncilSettingsSchema,
  approvalGates: z
    .record(z.enum(GATED_ACTIONS), z.boolean())
    .refine((gates) => HARD_GATED_ACTIONS.every((action) => gates[action] !== false), {
      message: 'dependency_addition cannot be disabled: every new dependency needs human approval (ADR-031)',
    }),
  highCostThresholdUsd: z.number().min(0).max(10_000),
  maxConcurrentTasks: z.number().int().min(1).max(20),
  modelOverrides: z.partialRecord(z.enum(AGENT_ROLES), z.string().min(1).max(200)),
});

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase letters, digits and dashes')
    .optional(),
  description: z.string().trim().max(2000).default(''),
  repo: RepoRefSchema.nullable().default(null),
  priority: z.number().int().min(1).max(10).default(5),
  autonomyLevel: z
    .number()
    .int()
    .min(0)
    .max(4)
    .default(1)
    .transform((v) => v as AutonomyLevel),
  budgetUsd: z.number().min(0).max(100_000).default(50),
});
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

function isSlugChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/**
 * Lower-cases `text` and joins its runs of `[a-z0-9]` with single dashes, without leading or trailing dashes. With
 * `maxLength`, the slug is cut to that length and a dash left at the cut is dropped.
 *
 * Same result as `.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')` (then `.slice(0, max)
 * .replace(/-+$/g, '')`), computed in one linear pass: titles and names are untrusted input and the `-+$` alternative
 * backtracks polynomially on long dash runs (CodeQL js/polynomial-redos).
 */
export function dashSlug(text: string, maxLength?: number): string {
  const lower = text.toLowerCase();
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const inRun = i < lower.length && isSlugChar(lower.charCodeAt(i));
    if (inRun && start < 0) start = i;
    else if (!inRun && start >= 0) {
      runs.push(lower.slice(start, i));
      start = -1;
    }
  }
  const slug = runs.join('-');
  if (maxLength === undefined) return slug;
  // Runs are joined by single dashes, so a cut leaves at most one trailing dash.
  const cut = slug.slice(0, maxLength);
  return cut.endsWith('-') ? cut.slice(0, -1) : cut;
}

export function slugify(name: string): string {
  const slug = dashSlug(name.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''), 64);
  return slug.length > 0 ? slug : 'project';
}
