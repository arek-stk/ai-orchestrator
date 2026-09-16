import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  COUNCIL_PROTOCOL_VERSION,
  type CouncilFinish,
  type CouncilRecord,
  type CouncilRepository,
  type CouncilTurnRecord,
  type DecisionRequest,
  type DecisionRequestPatch,
  type DecisionRequestRepository,
  type DecisionRequestStatus,
  type NewCouncil,
  type NewCouncilTurn,
  type NewDecisionRequest,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import * as t from './schema';

// Persistence for the autopilot decision ladder and council protocol v2 (docs/plans/autopilot.md §9.1). Council turns
// are append-only: a turn with an existing (council, seq) is never overwritten, so a resumed worker cannot rewrite
// the transcript.

const MAX_TURNS = 64;

function toRequest(row: typeof t.decisionRequests.$inferSelect): DecisionRequest {
  return { ...row };
}

function toCouncil(row: typeof t.councilSessions.$inferSelect): CouncilRecord {
  return { ...row };
}

function toTurn(row: typeof t.councilTurns.$inferSelect): CouncilTurnRecord {
  return { ...row };
}

export class DrizzleDecisionRequestRepository implements DecisionRequestRepository {
  constructor(private readonly db: Db) {}

  async open(input: NewDecisionRequest): Promise<{ request: DecisionRequest; created: boolean }> {
    // The partial unique index on (project, fingerprint) while open/resolving makes the dedupe atomic.
    const [created] = await this.db
      .insert(t.decisionRequests)
      .values({ id: newId('dqr'), ...input })
      .onConflictDoNothing({ target: [t.decisionRequests.projectId, t.decisionRequests.fingerprint], where: sql`status in ('open', 'resolving')` })
      .returning();
    if (created) return { request: toRequest(created), created: true };
    const [existing] = await this.db
      .select()
      .from(t.decisionRequests)
      .where(and(eq(t.decisionRequests.projectId, input.projectId), eq(t.decisionRequests.fingerprint, input.fingerprint), inArray(t.decisionRequests.status, ['open', 'resolving'])))
      .limit(1);
    if (!existing) throw new Error(`decision request ${input.fingerprint} vanished`);
    return { request: toRequest(existing), created: false };
  }

  async get(id: string): Promise<DecisionRequest | null> {
    const [row] = await this.db.select().from(t.decisionRequests).where(eq(t.decisionRequests.id, id)).limit(1);
    return row ? toRequest(row) : null;
  }

  async list(filter: { projectId?: string; sessionId?: string; statuses?: readonly DecisionRequestStatus[]; limit?: number }): Promise<DecisionRequest[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.decisionRequests.projectId, filter.projectId));
    if (filter.sessionId) conditions.push(eq(t.decisionRequests.sessionId, filter.sessionId));
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      conditions.push(inArray(t.decisionRequests.status, [...filter.statuses]));
    }
    const rows = await this.db
      .select()
      .from(t.decisionRequests)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.decisionRequests.createdAt), desc(t.decisionRequests.id))
      .limit(filter.limit ?? 100);
    return rows.map(toRequest);
  }

  async update(id: string, patch: DecisionRequestPatch): Promise<DecisionRequest> {
    const [row] = await this.db.update(t.decisionRequests).set(patch).where(eq(t.decisionRequests.id, id)).returning();
    if (!row) throw new Error(`decision request ${id} not found`);
    return toRequest(row);
  }
}

export class DrizzleCouncilRepository implements CouncilRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewCouncil): Promise<CouncilRecord> {
    const [row] = await this.db
      .insert(t.councilSessions)
      .values({ id: newId('cnc'), protocolVersion: COUNCIL_PROTOCOL_VERSION, ...input })
      .returning();
    return toCouncil(row!);
  }

  async get(id: string): Promise<CouncilRecord | null> {
    const [row] = await this.db.select().from(t.councilSessions).where(eq(t.councilSessions.id, id)).limit(1);
    return row ? toCouncil(row) : null;
  }

  async appendTurn(turn: NewCouncilTurn): Promise<CouncilTurnRecord> {
    const [created] = await this.db
      .insert(t.councilTurns)
      .values({ id: newId('ctn'), ...turn })
      .onConflictDoNothing({ target: [t.councilTurns.councilId, t.councilTurns.seq] })
      .returning();
    if (created) return toTurn(created);
    const [existing] = await this.db
      .select()
      .from(t.councilTurns)
      .where(and(eq(t.councilTurns.councilId, turn.councilId), eq(t.councilTurns.seq, turn.seq)))
      .limit(1);
    if (!existing) throw new Error(`council turn ${turn.councilId}#${turn.seq} vanished`);
    return toTurn(existing);
  }

  async turns(councilId: string): Promise<CouncilTurnRecord[]> {
    const rows = await this.db.select().from(t.councilTurns).where(eq(t.councilTurns.councilId, councilId)).orderBy(asc(t.councilTurns.seq)).limit(MAX_TURNS);
    return rows.map(toTurn);
  }

  async recordProgress(id: string, patch: Pick<CouncilRecord, 'participants' | 'roundsUsed' | 'costUsd' | 'tokens'>): Promise<void> {
    await this.db.update(t.councilSessions).set(patch).where(eq(t.councilSessions.id, id));
  }

  async finish(id: string, patch: CouncilFinish): Promise<CouncilRecord | null> {
    const [row] = await this.db
      .update(t.councilSessions)
      .set(patch)
      .where(and(eq(t.councilSessions.id, id), eq(t.councilSessions.status, 'running')))
      .returning();
    return row ? toCouncil(row) : null;
  }

  async sessionUsage(sessionId: string): Promise<{ councils: number; costUsd: number }> {
    const [row] = await this.db
      .select({ councils: sql<number>`cast(count(*) as int)`, costUsd: sql<number>`coalesce(sum(${t.councilSessions.costUsd}), 0)` })
      .from(t.councilSessions)
      .where(eq(t.councilSessions.sessionId, sessionId));
    return { councils: Number(row?.councils ?? 0), costUsd: Number(row?.costUsd ?? 0) };
  }

  async list(filter: { requestId?: string; sessionId?: string; limit?: number }): Promise<CouncilRecord[]> {
    const conditions: SQL[] = [];
    if (filter.requestId) conditions.push(eq(t.councilSessions.requestId, filter.requestId));
    if (filter.sessionId) conditions.push(eq(t.councilSessions.sessionId, filter.sessionId));
    const rows = await this.db
      .select()
      .from(t.councilSessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.councilSessions.createdAt), desc(t.councilSessions.id))
      .limit(filter.limit ?? 100);
    return rows.map(toCouncil);
  }
}

export interface LadderRepositories {
  decisionRequests: DrizzleDecisionRequestRepository;
  councils: DrizzleCouncilRepository;
}

export function createLadderRepositories(db: Db): LadderRepositories {
  return { decisionRequests: new DrizzleDecisionRequestRepository(db), councils: new DrizzleCouncilRepository(db) };
}
