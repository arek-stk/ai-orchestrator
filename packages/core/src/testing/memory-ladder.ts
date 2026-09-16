import type { CouncilRecord, CouncilRepository, CouncilTurnRecord } from '../autopilot/council-protocol';
import { COUNCIL_PROTOCOL_VERSION } from '../autopilot/council-protocol';
import type { DecisionRequest, DecisionRequestRepository } from '../autopilot/ladder';
import { systemClock, type Clock } from '../ports';

const clone = <T>(value: T): T => structuredClone(value);

/** In-memory decision requests and councils with the semantics of the Drizzle repositories (dedupe, append-only turns). */
export function createMemoryLadderStore(clock: Clock = systemClock) {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;
  const requestList: DecisionRequest[] = [];
  const councilList: CouncilRecord[] = [];
  const turnList: CouncilTurnRecord[] = [];

  const decisionRequests: DecisionRequestRepository & { all(): DecisionRequest[] } = {
    all: () => clone(requestList),
    open: async (input) => {
      const existing = requestList.find((r) => r.projectId === input.projectId && r.fingerprint === input.fingerprint && (r.status === 'open' || r.status === 'resolving'));
      if (existing) return { request: clone(existing), created: false };
      const request: DecisionRequest = {
        ...clone(input),
        id: id('dqr'),
        status: 'open',
        rung: null,
        trail: [],
        answer: null,
        parkReason: null,
        advisory: null,
        decisionId: null,
        approvalId: null,
        councilId: null,
        costUsd: 0,
        createdAt: clock.now(),
        resolvedAt: null,
      };
      requestList.push(request);
      return { request: clone(request), created: true };
    },
    get: async (requestId) => clone(requestList.find((r) => r.id === requestId) ?? null),
    list: async (filter) =>
      clone(
        [...requestList]
          .reverse()
          .filter((r) => (!filter.projectId || r.projectId === filter.projectId) && (!filter.sessionId || r.sessionId === filter.sessionId) && (!filter.statuses || filter.statuses.includes(r.status)))
          .slice(0, filter.limit ?? 100),
      ),
    update: async (requestId, patch) => {
      const request = requestList.find((r) => r.id === requestId);
      if (!request) throw new Error(`decision request ${requestId} not found`);
      Object.assign(request, clone(patch));
      return clone(request);
    },
  };

  const councils: CouncilRepository & { allTurns(): CouncilTurnRecord[] } = {
    allTurns: () => clone(turnList),
    create: async (input) => {
      const council: CouncilRecord = {
        ...clone(input),
        id: id('cnc'),
        protocolVersion: COUNCIL_PROTOCOL_VERSION,
        participants: [],
        diversity: null,
        status: 'running',
        chosenOptionId: null,
        confidence: null,
        parkReason: null,
        roundsUsed: 0,
        costUsd: 0,
        tokens: 0,
        createdAt: clock.now(),
        finishedAt: null,
      };
      councilList.push(council);
      return clone(council);
    },
    get: async (councilId) => clone(councilList.find((c) => c.id === councilId) ?? null),
    appendTurn: async (input) => {
      const existing = turnList.find((t) => t.councilId === input.councilId && t.seq === input.seq);
      if (existing) return clone(existing);
      const turn: CouncilTurnRecord = { ...clone(input), id: id('ctn'), createdAt: clock.now() };
      turnList.push(turn);
      return clone(turn);
    },
    turns: async (councilId) => clone(turnList.filter((t) => t.councilId === councilId).sort((a, b) => a.seq - b.seq)),
    recordProgress: async (councilId, patch) => {
      const council = councilList.find((c) => c.id === councilId);
      if (council) Object.assign(council, clone(patch));
    },
    finish: async (councilId, patch) => {
      const council = councilList.find((c) => c.id === councilId);
      if (!council || council.status !== 'running') return null;
      Object.assign(council, clone(patch));
      return clone(council);
    },
    sessionUsage: async (sessionId) => {
      const inSession = councilList.filter((c) => c.sessionId === sessionId);
      return { councils: inSession.length, costUsd: inSession.reduce((sum, c) => sum + c.costUsd, 0) };
    },
    list: async (filter) =>
      clone(
        [...councilList]
          .reverse()
          .filter((c) => (!filter.requestId || c.requestId === filter.requestId) && (!filter.sessionId || c.sessionId === filter.sessionId))
          .slice(0, filter.limit ?? 100),
      ),
  };

  return { decisionRequests, councils };
}

export type MemoryLadderStore = ReturnType<typeof createMemoryLadderStore>;
