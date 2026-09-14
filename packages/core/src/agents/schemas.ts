import { z } from 'zod';
import { COMPLEXITIES } from '../domain/enums';

// Output contracts for every agent (ADR-010). Fields are required and nullable rather than optional
// so the same schema works with strict structured-output modes across providers.

const Confidence = z.number().min(0).max(1);
const Text = (max = 4000) => z.string().max(max);
const List = (max = 30, itemMax = 1000) => z.array(z.string().max(itemMax)).max(max);
const Severity = z.enum(['critical', 'high', 'medium', 'low']);

export const FileChangeSchema = z.object({
  path: z.string().min(1).max(500),
  action: z.enum(['create', 'update', 'delete']),
  /** Full file content for create/update; null for delete. */
  content: z.string().max(400_000).nullable(),
  rationale: Text(1000),
});
export type FileChangeOutput = z.infer<typeof FileChangeSchema>;

export const AnalysisOutputSchema = z.object({
  summary: Text(4000),
  architecture: Text(4000),
  relevantPaths: List(40, 500),
  conventions: List(20),
  risks: List(20),
  techDebt: List(20),
  confidence: Confidence,
});
export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

export const PLAN_TASK_ROLES = ['builder', 'frontend', 'backend', 'database', 'tester', 'documentation', 'devops'] as const;

export const PlanOutputSchema = z.object({
  goal: Text(2000),
  approach: Text(4000),
  tasks: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9-]{1,40}$/),
        title: Text(200),
        description: Text(2000),
        role: z.enum(PLAN_TASK_ROLES),
        dependsOn: z.array(z.string().max(40)).max(20),
        acceptanceCriteria: List(15, 500),
      }),
    )
    .min(1)
    .max(15),
  risks: z.array(z.object({ description: Text(1000), severity: z.enum(['low', 'medium', 'high']), mitigation: Text(1000) })).max(15),
  acceptanceCriteria: List(20, 500),
  estimatedComplexity: z.enum(COMPLEXITIES),
  requiresDesign: z.boolean(),
  touchesAreas: List(20, 200),
  openQuestions: List(10, 500),
  confidence: Confidence,
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export const DesignOpinionSchema = z.object({
  options: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), summary: Text(1000), pros: List(8, 400), cons: List(8, 400) }))
    .min(1)
    .max(4),
  recommendedOptionId: z.string().max(40),
  rationale: Text(3000),
  risks: List(10, 500),
  confidence: Confidence,
});
export type DesignOpinion = z.infer<typeof DesignOpinionSchema>;

export const BuildOutputSchema = z.object({
  summary: Text(3000),
  changes: z.array(FileChangeSchema).max(60),
  notes: List(20),
  confidence: Confidence,
});
export type BuildOutput = z.infer<typeof BuildOutputSchema>;

export const TestOutputSchema = z.object({
  summary: Text(2000),
  testFiles: z.array(FileChangeSchema).max(30),
  coverageNotes: List(20),
  confidence: Confidence,
});
export type TestOutput = z.infer<typeof TestOutputSchema>;

export const DebugOutputSchema = z.object({
  reproduction: Text(3000),
  rootCause: Text(3000),
  evidence: List(15),
  isInfrastructureIssue: z.boolean(),
  fix: z.array(FileChangeSchema).max(40),
  confidence: Confidence,
});
export type DebugOutput = z.infer<typeof DebugOutputSchema>;

export const ReviewOutputSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  summary: Text(3000),
  issues: z
    .array(z.object({ severity: Severity, path: z.string().max(500).nullable(), description: Text(2000), suggestion: Text(2000) }))
    .max(40),
  acceptanceCriteria: z.array(z.object({ criterion: Text(500), met: z.boolean(), evidence: Text(1000) })).max(30),
  confidence: Confidence,
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const SecurityOutputSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  summary: Text(3000),
  findings: z
    .array(
      z.object({
        severity: Severity,
        category: Text(100),
        path: z.string().max(500).nullable(),
        description: Text(2000),
        remediation: Text(2000),
      }),
    )
    .max(40),
  confidence: Confidence,
});
export type SecurityOutput = z.infer<typeof SecurityOutputSchema>;

export const SynthesisOutputSchema = z.object({
  decision: Text(2000),
  chosenOptionId: z.string().max(40).nullable(),
  reason: Text(3000),
  dissent: List(10),
  evidence: List(15),
  confidence: Confidence,
});
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

export const BlockerAnalysisSchema = z.object({
  why: Text(3000),
  missingInformation: List(10),
  alternativeApproach: z.string().max(3000).nullable(),
  needsHuman: z.boolean(),
  confidence: Confidence,
});
export type BlockerAnalysis = z.infer<typeof BlockerAnalysisSchema>;
