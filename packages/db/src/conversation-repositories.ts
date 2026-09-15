import { and, asc, desc, eq, gt, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type {
  Conversation,
  ConversationMessage,
  ConversationMessageRepository,
  ConversationRepository,
  MessageWindow,
  NewConversationMessage,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import * as t from './schema';

// Persistence of the unified conversation model: the Project Room today, planning/explain/council threads later.

function toConversation(row: typeof t.conversations.$inferSelect): Conversation {
  return { ...row };
}

function toMessage(row: typeof t.conversationMessages.$inferSelect): ConversationMessage {
  const { dedupeKey: _dedupeKey, ...message } = row;
  return message;
}

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: Db) {}

  async ensureRoom(projectId: string): Promise<Conversation> {
    // The partial unique index conversations_project_room_uq makes first use race-free across requests and processes.
    const [created] = await this.db
      .insert(t.conversations)
      .values({ id: newId('cnv'), projectId, kind: 'room', title: 'Project room' })
      .onConflictDoNothing({ target: t.conversations.projectId, where: sql`kind = 'room'` })
      .returning();
    if (created) return toConversation(created);
    const [existing] = await this.db
      .select()
      .from(t.conversations)
      .where(and(eq(t.conversations.projectId, projectId), eq(t.conversations.kind, 'room')))
      .limit(1);
    if (!existing) throw new Error(`room for project ${projectId} could not be created`);
    return toConversation(existing);
  }

  async get(id: string): Promise<Conversation | null> {
    const [row] = await this.db.select().from(t.conversations).where(eq(t.conversations.id, id)).limit(1);
    return row ? toConversation(row) : null;
  }
}

export class DrizzleConversationMessageRepository implements ConversationMessageRepository {
  constructor(private readonly db: Db) {}

  async append(input: NewConversationMessage): Promise<{ message: ConversationMessage; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t.conversationMessages)
        .values({ id: newId('msg'), ...input })
        .onConflictDoNothing({ target: [t.conversationMessages.conversationId, t.conversationMessages.dedupeKey], where: sql`dedupe_key is not null` })
        .returning();
      if (!row) {
        const [existing] = await tx
          .select()
          .from(t.conversationMessages)
          .where(and(eq(t.conversationMessages.conversationId, input.conversationId), eq(t.conversationMessages.dedupeKey, input.dedupeKey ?? '')))
          .limit(1);
        if (!existing) throw new Error(`message with dedupe key ${input.dedupeKey} vanished`);
        return { message: toMessage(existing), created: false };
      }
      if (row.threadId) {
        await tx
          .update(t.conversationMessages)
          .set({ replyCount: sql`${t.conversationMessages.replyCount} + 1`, lastReplyAt: row.createdAt })
          .where(eq(t.conversationMessages.id, row.threadId));
      }
      await tx
        .update(t.conversations)
        .set({ messageCount: sql`${t.conversations.messageCount} + 1`, lastActivityAt: row.createdAt, updatedAt: row.createdAt })
        .where(eq(t.conversations.id, input.conversationId));
      return { message: toMessage(row), created: true };
    });
  }

  async get(id: string): Promise<ConversationMessage | null> {
    const [row] = await this.db.select().from(t.conversationMessages).where(eq(t.conversationMessages.id, id)).limit(1);
    return row ? toMessage(row) : null;
  }

  async listTopLevel(conversationId: string, window: MessageWindow): Promise<ConversationMessage[]> {
    const conditions: SQL[] = [eq(t.conversationMessages.conversationId, conversationId), isNull(t.conversationMessages.threadId)];
    if (window.after !== undefined) {
      conditions.push(gt(t.conversationMessages.seq, window.after));
      const rows = await this.db.select().from(t.conversationMessages).where(and(...conditions)).orderBy(asc(t.conversationMessages.seq)).limit(window.limit);
      return rows.map(toMessage);
    }
    if (window.before !== undefined) conditions.push(lt(t.conversationMessages.seq, window.before));
    const rows = await this.db.select().from(t.conversationMessages).where(and(...conditions)).orderBy(desc(t.conversationMessages.seq)).limit(window.limit);
    return rows.reverse().map(toMessage);
  }

  async listThread(threadId: string, window: Omit<MessageWindow, 'before'>): Promise<ConversationMessage[]> {
    const conditions: SQL[] = [eq(t.conversationMessages.threadId, threadId)];
    if (window.after !== undefined) conditions.push(gt(t.conversationMessages.seq, window.after));
    const rows = await this.db.select().from(t.conversationMessages).where(and(...conditions)).orderBy(asc(t.conversationMessages.seq)).limit(window.limit);
    return rows.map(toMessage);
  }
}

export interface ConversationRepositories {
  conversations: DrizzleConversationRepository;
  messages: DrizzleConversationMessageRepository;
}

export function createConversationRepositories(db: Db): ConversationRepositories {
  return { conversations: new DrizzleConversationRepository(db), messages: new DrizzleConversationMessageRepository(db) };
}
