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

// ---------------------------------------------------------------------------
// Orchestration intelligence: health scan, file summaries, specialists
// ---------------------------------------------------------------------------

export const IMPROVEMENT_CATEGORIES = ['tech_debt', 'missing_tests', 'outdated_dependencies', 'security_risk', 'performance', 'ux', 'documentation'] as const;
export type ImprovementCategory = (typeof IMPROVEMENT_CATEGORIES)[number];
export const IMPACTS = ['low', 'medium', 'high'] as const;
export type Impact = (typeof IMPACTS)[number];
export const EFFORTS = ['small', 'medium', 'large'] as const;
export type Effort = (typeof EFFORTS)[number];

export const ProposalItemSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,60}$/),
  category: z.enum(IMPROVEMENT_CATEGORIES),
  title: Text(200),
  description: Text(2000),
  rationale: Text(2000),
  evidence: List(10, 500),
  affectedPaths: List(20, 500),
  impact: z.enum(IMPACTS),
  effort: z.enum(EFFORTS),
  risk: z.enum(['low', 'medium', 'high']),
  acceptanceCriteria: List(10, 500),
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const HealthScanOutputSchema = z.object({
  summary: Text(3000),
  proposals: z.array(ProposalItemSchema).max(15),
  confidence: Confidence,
});
export type HealthScanOutput = z.infer<typeof HealthScanOutputSchema>;

export const DevOpsOutputSchema = z.object({
  summary: Text(3000),
  suggestions: z.array(ProposalItemSchema.extend({ area: z.enum(['ci', 'docker', 'deployment', 'observability']) })).max(10),
  confidence: Confidence,
});
export type DevOpsOutput = z.infer<typeof DevOpsOutputSchema>;

export const FileSummaryOutputSchema = z.object({
  summaries: z.array(z.object({ path: z.string().min(1).max(500), summary: Text(800) })).max(20),
  confidence: Confidence,
});
export type FileSummaryOutput = z.infer<typeof FileSummaryOutputSchema>;

export const ResearchOutputSchema = z.object({
  question: Text(1000),
  findings: z.array(z.object({ claim: Text(1000), source: z.string().max(500).nullable(), confidence: Confidence })).max(15),
  recommendation: Text(3000),
  limitations: List(10, 500),
  openQuestions: List(10, 500),
  confidence: Confidence,
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

/** Same shape as the build output; verification and the docs.write tool restrict it to documentation paths. */
export const DocumentationOutputSchema = z.object({
  summary: Text(3000),
  changes: z.array(FileChangeSchema).max(30),
  notes: List(20),
  confidence: Confidence,
});
export type DocumentationOutput = z.infer<typeof DocumentationOutputSchema>;

export const RELEASE_CHECK_NAMES = ['tests', 'security', 'migrations', 'changelog', 'version', 'ci'] as const;
export type ReleaseCheckName = (typeof RELEASE_CHECK_NAMES)[number];
export const RELEASE_CHECK_STATUSES = ['pass', 'fail', 'warn', 'skipped'] as const;
export type ReleaseCheckStatus = (typeof RELEASE_CHECK_STATUSES)[number];

export const ReleaseReadinessOutputSchema = z.object({
  verdict: z.enum(['ready', 'not_ready']),
  summary: Text(3000),
  checks: z.array(z.object({ name: z.enum(RELEASE_CHECK_NAMES), status: z.enum(RELEASE_CHECK_STATUSES), detail: Text(1000) })).max(12),
  blockers: List(10, 500),
  confidence: Confidence,
});
export type ReleaseReadinessOutput = z.infer<typeof ReleaseReadinessOutputSchema>;

// ---------------------------------------------------------------------------
// Autopilot decision ladder and council protocol v2 (docs/plans/autopilot.md §3–4)
// ---------------------------------------------------------------------------

/**
 * Evidence a model cites. It is data, never trusted: the orchestrator verifies every item deterministically (the path
 * exists in the index, the quote is in the file/ADR/decision, the ADR is accepted, the check was executed) and drops
 * or refutes what does not verify.
 */
export const EVIDENCE_TYPES = ['file', 'adr', 'decision', 'state', 'check'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EvidenceItemSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  /** file: repository path · adr: "ADR-034" · decision: decision id · state: "docs/STATE.md" · check: check name. */
  ref: z.string().min(1).max(300),
  /** Verbatim excerpt; required for file, adr, decision and state evidence. */
  quote: z.string().max(600).nullable(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const OptionIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const PrecedentCheckOutputSchema = z.object({
  verdict: z.enum(['applies', 'conflicts', 'not_applicable']),
  /** Reference of the precedent as listed in the input, e.g. "adr:ADR-034". */
  precedentRef: z.string().max(120).nullable(),
  /** Verbatim quote from that precedent supporting the verdict. */
  quote: z.string().max(600).nullable(),
  /** The answer the precedent implies (applies) or the conflicting rule (conflicts). */
  answer: Text(2000),
  rationale: Text(2000),
  confidence: Confidence,
});
export type PrecedentCheckOutput = z.infer<typeof PrecedentCheckOutputSchema>;

export const DecisionResearchOutputSchema = z.object({
  answer: Text(3000),
  /** The provided repository excerpts answer the question; false when judgment or missing information remains. */
  settled: z.boolean(),
  citations: z.array(z.object({ path: z.string().min(1).max(500), quote: z.string().max(600), supports: Text(500) })).max(8),
  limitations: List(8, 500),
  confidence: Confidence,
});
export type DecisionResearchOutput = z.infer<typeof DecisionResearchOutputSchema>;

export const CouncilOptionSchema = z.object({
  id: OptionIdSchema,
  summary: Text(1000),
  reversibility: z.enum(['easy', 'moderate', 'hard']),
  blastRadius: z.enum(['small', 'medium', 'large']),
  estimatedCost: z.enum(['low', 'medium', 'high']),
});
export type CouncilOption = z.infer<typeof CouncilOptionSchema>;

export const CouncilProposalSchema = z.object({
  options: z.array(CouncilOptionSchema).min(1).max(4),
  recommendedOptionId: z.string().max(40),
  claims: z.array(z.object({ optionId: z.string().max(40).nullable(), text: Text(1000), evidence: z.array(EvidenceItemSchema).max(4) })).max(6),
  assumptions: List(6, 500),
  confidence: Confidence,
});
export type CouncilProposal = z.infer<typeof CouncilProposalSchema>;

export const OBJECTION_SEVERITIES = ['blocking', 'major', 'minor'] as const;
export const OBJECTION_KINDS = ['risk', 'incorrect_claim', 'adr_conflict', 'product_intent', 'security', 'other'] as const;

export const CouncilCritiqueSchema = z.object({
  objections: z
    .array(
      z.object({
        id: z.string().regex(/^obj-[a-z0-9-]{1,30}$/),
        targetOptionId: z.string().max(40),
        severity: z.enum(OBJECTION_SEVERITIES),
        kind: z.enum(OBJECTION_KINDS),
        claim: Text(1000),
        evidence: z.array(EvidenceItemSchema).max(4),
        /** Name of an allow-listed project check that would falsify the objection (test, lint, typecheck, build). */
        falsifier: z.string().max(40).nullable(),
      }),
    )
    .max(6),
  confidence: Confidence,
});
export type CouncilCritique = z.infer<typeof CouncilCritiqueSchema>;
export type CouncilObjection = CouncilCritique['objections'][number];

export const CouncilVoteSchema = z.object({
  responses: z
    .array(z.object({ objectionId: z.string().max(40), stance: z.enum(['accept', 'rebut']), argument: Text(800), evidence: z.array(EvidenceItemSchema).max(4) }))
    .max(6),
  /** An option id, or "park" when the question should go to a human. */
  optionId: z.string().max(40),
  /** Objection or evidence id that changed the member's mind since round 1; null when unchanged. */
  changedBecause: z.string().max(80).nullable(),
  confidence: Confidence,
});
export type CouncilVote = z.infer<typeof CouncilVoteSchema>;
