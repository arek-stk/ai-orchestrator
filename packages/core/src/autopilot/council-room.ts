import type { CouncilCritique, CouncilProposal, CouncilVote } from '../agents/schemas';
import { sanitizeInline } from '../room/content';
import type { RoomService } from '../room/service';
import type { MessageAuthorType, MessageIntent } from '../room/types';
import type { CouncilBrief, CouncilRecord, CouncilState, CouncilSynthesis, CouncilTurnRecord, CouncilTurnSink, ExperimentBody } from './council-protocol';
import type { VerifiedEvidence } from './evidence';

// Visibility (docs/plans/autopilot.md §7.1): a council transcript becomes one thread in the Project Room, posted
// append-only through the room service (sanitised, redacted, deduplicated by turn). The thread root is the brief; each
// later turn is one typed reply. Bounded: at most MAX_COUNCIL_ROOM_MESSAGES per council and short, plain-text bodies.
// The stored `council_turns` stay the source of truth; the room is a projection.

export const MAX_COUNCIL_ROOM_MESSAGES = 14;
const BODY_CHARS = 1_200;

export interface CouncilRoomNotice {
  authorType: MessageAuthorType;
  authorName: string;
  intent: MessageIntent;
  body: string;
  dedupeKey: string;
}

const line = (text: string, max = 300) => sanitizeInline(text, max);
const pct = (value: number) => `${Math.round(value * 100)}%`;
const titleCase = (role: string) => role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, ' ');

/** Describes one stored turn as a room message. Pure. */
export function describeCouncilTurn(council: Pick<CouncilRecord, 'id'>, turn: CouncilTurnRecord): CouncilRoomNotice | null {
  const dedupeKey = `council:${council.id}:turn:${turn.seq}`;
  const orchestrator = { authorType: 'orchestrator' as const, authorName: 'Orchestrator' };
  const body = turn.body as Record<string, unknown>;
  switch (turn.kind) {
    case 'brief': {
      const brief = body as unknown as CouncilBrief;
      return {
        ...orchestrator,
        intent: 'status',
        dedupeKey,
        body: [
          `Council convened (${brief.decisionType.replace(/_/g, ' ')}): ${line(brief.question, 500)}`,
          `Members: ${brief.members.join(', ')} · critic on a different model where possible · ${brief.rounds} round(s).`,
          brief.constraints.length > 0 ? `Precedents to respect: ${brief.constraints.map((c) => c.ref).join(', ')}.` : '',
          'The council can only settle a provisional decision; gated actions and product intent stay with a human.',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    case 'proposal':
    case 'vote':
    case 'critique': {
      const author = { authorType: 'agent' as const, authorName: turn.stance === 'critic' ? 'Critic' : titleCase(turn.role) };
      if (body.ok !== true) return { ...author, intent: 'status', dedupeKey, body: `${author.authorName} could not contribute: ${line(String(body.error ?? 'failed'))}` };
      if (turn.kind === 'proposal') {
        const output = body.output as CouncilProposal;
        return {
          ...author,
          intent: 'message',
          dedupeKey,
          body: [
            `Recommends ${output.recommendedOptionId}.`,
            ...output.options.map((o) => `• ${o.id}: ${line(o.summary, 200)} (reversibility ${o.reversibility}, blast radius ${o.blastRadius})`),
            ...output.claims.slice(0, 3).map((c) => `Claim: ${line(c.text, 200)}${c.evidence.length > 0 ? ` [${c.evidence.length} evidence]` : ''}`),
          ].join('\n'),
        };
      }
      if (turn.kind === 'critique') {
        const output = body.output as CouncilCritique;
        return {
          ...author,
          intent: 'objection',
          dedupeKey,
          body: output.objections.length === 0 ? 'No objections.' : output.objections.map((o) => `${o.id} (${o.severity}, ${o.kind.replace(/_/g, ' ')}) against ${o.targetOptionId}: ${line(o.claim, 220)}`).join('\n'),
        };
      }
      const output = body.output as CouncilVote;
      return {
        ...author,
        intent: 'message',
        dedupeKey,
        body: [
          `Votes ${output.optionId}${output.changedBecause ? ` (changed because of ${line(output.changedBecause, 80)})` : ''}.`,
          ...output.responses.slice(0, 4).map((r) => `${r.stance === 'rebut' ? 'Rebuts' : 'Accepts'} ${line(r.objectionId, 40)}: ${line(r.argument, 160)}`),
        ].join('\n'),
      };
    }
    case 'evidence_result': {
      const items = (body.items as VerifiedEvidence[] | undefined) ?? [];
      if (items.length === 0) return null;
      const count = (status: string) => items.filter((i) => i.status === status).length;
      const refuted = items.filter((i) => i.status === 'refuted').slice(0, 3);
      return {
        ...orchestrator,
        intent: 'status',
        dedupeKey,
        body: [
          `Evidence check (round ${String(body.round)}): ${count('verified')} verified, ${count('unverified')} unverified, ${count('refuted')} refuted.`,
          ...refuted.map((i) => `Refuted ${i.type} ${line(i.ref, 120)}: ${line(i.detail, 160)}`),
        ].join('\n'),
      };
    }
    case 'experiment': {
      const experiment = body as unknown as ExperimentBody;
      return {
        ...orchestrator,
        intent: 'status',
        dedupeKey,
        body: experiment.skipped ? `Experiment skipped: ${line(experiment.reason)}` : experiment.results.map((r) => `Check ${r.name} for ${r.optionId}: ${r.passed ? 'passed' : 'failed'}`).join('\n'),
      };
    }
    case 'synthesis': {
      const synthesis = body as unknown as CouncilSynthesis;
      const diversity = `${synthesis.diversity.replace(/_/g, ' ')}${synthesis.singleProvider ? ', single provider' : ''}`;
      return {
        ...orchestrator,
        intent: 'decision',
        dedupeKey,
        body: [
          synthesis.outcome === 'decided'
            ? `Provisional decision: ${synthesis.chosenOptionId} (${pct(synthesis.confidence)} confidence, threshold ${pct(synthesis.threshold)}, diversity ${diversity}). A human confirms or rejects it in the return digest.`
            : `Parked for a human (${(synthesis.parkReason ?? 'unknown').replace(/_/g, ' ')}; diversity ${diversity}).${synthesis.leadingOptionId ? ` Leading option: ${synthesis.leadingOptionId}.` : ''}`,
          ...synthesis.reasons.slice(-3).map((r) => `• ${line(r, 220)}`),
        ].join('\n'),
      };
    }
  }
}

/** Posts council turns into the project's room as one thread. */
export class CouncilRoomPublisher implements CouncilTurnSink {
  constructor(private readonly room: Pick<RoomService, 'post'>) {}

  async publish(council: CouncilRecord, turn: CouncilTurnRecord, _state: CouncilState): Promise<void> {
    if (turn.seq >= MAX_COUNCIL_ROOM_MESSAGES) return;
    const notice = describeCouncilTurn(council, turn);
    if (!notice) return;
    const refs = council.runId ? { runId: council.runId } : {};
    if (turn.kind === 'brief') {
      await this.room.post({ projectId: council.projectId, author: { type: notice.authorType, id: null, name: notice.authorName }, intent: notice.intent, body: notice.body.slice(0, BODY_CHARS), refs, dedupeKey: notice.dedupeKey });
      return;
    }
    // The root is posted with the brief; re-posting it with the same dedupe key returns the stored message.
    const root = await this.room.post({
      projectId: council.projectId,
      author: { type: 'orchestrator', id: null, name: 'Orchestrator' },
      intent: 'status',
      body: `Council ${council.id}`,
      refs,
      dedupeKey: `council:${council.id}:turn:0`,
    });
    await this.room.post({
      projectId: council.projectId,
      author: { type: notice.authorType, id: null, name: notice.authorName },
      intent: notice.intent,
      body: notice.body.slice(0, BODY_CHARS),
      threadId: root.message.id,
      refs,
      dedupeKey: notice.dedupeKey,
    });
  }
}
