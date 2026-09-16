'use client';

import { Check, CircleHelp, MessagesSquare, Scale, X } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatConfidence, formatUsd, humanize } from '@/lib/format';
import type { Tone } from '@/lib/status';
import type { CouncilDiversity, DecisionOrigin, DecisionReviewStatus, DigestDecision, DigestQuestion } from '@/lib/types';
import { Button, Chip, EmptyState, StatusBadge, TextLink, textareaClass } from './ui';

// Autopilot stage 2+3 in the return digest: provisional decisions settled by the decision ladder (precedent, research
// or council) that a human confirms or rejects, and questions parked for a human. Model-written text is rendered as
// plain text only.

const ORIGIN_LABEL: Record<DecisionOrigin, string> = {
  pipeline: 'Pipeline council',
  autopilot_precedent: 'Precedent (ADR, state or earlier decision)',
  autopilot_research: 'Repository research',
  autopilot_council: 'Council with critic',
  human: 'Human',
};

const STATUS_TONE: Record<DecisionReviewStatus, Tone> = { provisional: 'warning', confirmed: 'good', rejected: 'critical', active: 'muted' };

const DIVERSITY_TEXT: Record<CouncilDiversity, { label: string; title: string; tone: Tone }> = {
  cross_provider: { label: 'Critic on another provider', title: 'The critic ran on a different model provider than every member.', tone: 'good' },
  cross_model: { label: 'Single provider', title: 'Only one provider is configured: the critic ran on another model of it and the decision needed a higher confidence.', tone: 'warning' },
  none: { label: 'No model diversity', title: 'The critic ran on the same model as the members; such a council only advises.', tone: 'critical' },
};

const projectRoomHref = (projectId: string) => `/projects/${encodeURIComponent(projectId)}?tab=room`;

function ReviewControls({ decision, onDone }: { decision: DigestDecision; onDone: () => void }) {
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();

  const submit = async (verdict: 'confirm' | 'reject', body: object) => {
    setBusy(verdict);
    setError(null);
    try {
      await api(`/api/autopilot/decisions/${encodeURIComponent(decision.decisionId)}/${verdict}`, { method: 'POST', body });
      setMode('idle');
      setReason('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onReject = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length >= 3) void submit('reject', { reason: reason.trim() });
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      {mode === 'idle' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" icon={Check} busy={busy === 'confirm'} onClick={() => void submit('confirm', {})}>
            Confirm
          </Button>
          <Button size="sm" variant="danger" icon={X} onClick={() => setMode('reject')}>
            Reject
          </Button>
        </div>
      ) : (
        <form onSubmit={onReject} className="flex max-w-xl flex-col gap-2">
          <label htmlFor={reasonId} className="text-xs font-medium text-ink-2">
            Why is this decision wrong? Rejected decisions are never reused.
          </label>
          <textarea id={reasonId} className={textareaClass} rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="danger" type="submit" icon={X} busy={busy === 'reject'} disabled={reason.trim().length < 3}>
              Reject decision
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-xs text-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Decisions the autopilot settled while nobody was watching. Provisional ones wait for an admin's review. */
export function DecisionReviewList({
  decisions,
  canReview,
  projectLink,
  onChanged,
}: {
  decisions: DigestDecision[];
  canReview: boolean;
  projectLink: (projectId: string) => ReactNode;
  onChanged: () => void;
}) {
  if (decisions.length === 0) return <EmptyState icon={Scale} title="No decisions recorded" hint="Questions the ladder settles appear here for review." />;
  return (
    <ul className="divide-y divide-line">
      {decisions.map((decision) => {
        const diversity = decision.diversity ? DIVERSITY_TEXT[decision.diversity] : null;
        return (
          <li key={decision.decisionId} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] font-medium text-ink">{decision.question}</p>
                <p className="mt-1 whitespace-pre-line break-words text-[13px] text-ink">{decision.decision}</p>
              </div>
              <StatusBadge tone={STATUS_TONE[decision.status]} label={decision.status === 'provisional' ? 'Waiting for review' : humanize(decision.status)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Chip title="How the question was settled">{ORIGIN_LABEL[decision.origin]}</Chip>
              <Chip>{formatConfidence(decision.confidence)} confidence</Chip>
              {diversity ? <StatusBadge tone={diversity.tone} label={diversity.label} title={diversity.title} /> : null}
              {decision.adrRefs.map((ref) => (
                <Chip key={ref} title="Accepted ADR the rationale relies on">
                  {ref}
                </Chip>
              ))}
            </div>
            <details className="mt-2 text-[13px] text-ink-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-ink-2 hover:text-ink">Rationale{decision.dissent.length > 0 ? ' and dissent' : ''}</summary>
              <p className="mt-1.5 whitespace-pre-line break-words">{decision.reason}</p>
              {decision.dissent.length > 0 ? (
                <ul className="mt-1.5 list-disc pl-5">
                  {decision.dissent.map((d) => (
                    <li key={d} className="break-words">
                      {d}
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
              {projectLink(decision.projectId)}
              {decision.runId ? <TextLink href={`/runs/${decision.runId}`}>View run</TextLink> : null}
              {decision.councilId ? (
                <TextLink href={projectRoomHref(decision.projectId)}>
                  <span className="inline-flex items-center gap-1">
                    <MessagesSquare aria-hidden="true" size={12} />
                    Council thread in the Room
                  </span>
                </TextLink>
              ) : null}
              {decision.reviewedBy ? (
                <span>
                  {humanize(decision.status)} by {decision.reviewedBy}
                  {decision.reviewComment ? `: ${decision.reviewComment}` : ''}
                </span>
              ) : null}
            </p>
            {decision.status === 'provisional' && canReview ? <ReviewControls decision={decision} onDone={onChanged} /> : null}
            {decision.status === 'provisional' && !canReview ? <p className="mt-2 text-xs text-ink-2">An admin confirms or rejects this decision.</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

const OUTCOME_LABEL: Record<string, string> = { answered: 'answered', conflict: 'conflict', not_applicable: 'no match', escalated: 'escalated', skipped: 'skipped', parked: 'parked' };

/** Questions the ladder handled, with the rungs it climbed; parked ones link to the approval a human decides. */
export function QuestionList({ questions, projectLink }: { questions: DigestQuestion[]; projectLink: (projectId: string) => ReactNode }) {
  if (questions.length === 0) return <EmptyState icon={CircleHelp} title="No questions" hint="Design questions of session runs climb precedent, research and council before they reach you." />;
  return (
    <ul className="divide-y divide-line">
      {questions.map((question) => (
        <li key={question.requestId} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-0 flex-1 break-words text-[13px] font-medium text-ink">{question.question}</p>
            <StatusBadge
              tone={question.status === 'parked' ? 'warning' : question.status === 'answered' || question.status === 'answered_by_human' ? 'good' : 'muted'}
              label={question.status === 'parked' ? 'Parked for you' : humanize(question.status)}
            />
          </div>
          <ol aria-label="Ladder rungs" className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
            {question.trail.map((step, index) => (
              <li key={`${step.rung}-${index}`} title={step.detail}>
                <Chip>
                  {humanize(step.rung)}: {OUTCOME_LABEL[step.outcome] ?? humanize(step.outcome)}
                </Chip>
              </li>
            ))}
          </ol>
          {question.status === 'parked' ? (
            <p className="mt-2 break-words text-[13px] text-ink-2">
              Reason: {humanize(question.parkReason ?? 'unresolved')}.
              {question.advisory ? ` Advisory (not a decision): ${question.advisory.leadingOptionId ? `${question.advisory.leadingOptionId}: ` : ''}${question.advisory.summary}` : ''}
            </p>
          ) : null}
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
            {projectLink(question.projectId)}
            {question.taskTitle ? <span>{question.taskTitle}</span> : null}
            <span>{formatUsd(question.costUsd)}</span>
            {question.approvalId && question.status === 'parked' ? <TextLink href="/approvals">Decide the parked approval</TextLink> : null}
            {question.councilId ? <TextLink href={projectRoomHref(question.projectId)}>Council thread</TextLink> : null}
          </p>
        </li>
      ))}
    </ul>
  );
}
