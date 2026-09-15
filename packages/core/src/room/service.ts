import type { EventRecorder } from '../ports';
import { sanitizeInline, sanitizeMessageBody } from './content';
import {
  MAX_AUTHOR_NAME_LENGTH,
  PostMessageInputSchema,
  type Conversation,
  type ConversationMessage,
  type ConversationMessageRepository,
  type ConversationRepository,
  type PostMessageInput,
} from './types';

export const MAX_PAGE_SIZE = 100;

export type RoomErrorCode = 'empty_body' | 'thread_not_found' | 'answer_requires_thread';

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export interface RoomServiceDeps {
  conversations: ConversationRepository;
  messages: ConversationMessageRepository;
  /** Receives `room.message`. Must not be a room-projecting recorder, or notices would project themselves. */
  events: EventRecorder;
}

export interface MessagePage {
  conversation: Conversation;
  messages: ConversationMessage[];
  /** More messages exist beyond the window (older for `before`/latest, newer for `after`). */
  hasMore: boolean;
}

export interface ThreadPage {
  root: ConversationMessage;
  replies: ConversationMessage[];
  hasMore: boolean;
}

const pageSize = (limit: number | undefined) => Math.min(Math.max(Math.trunc(limit ?? 50), 1), MAX_PAGE_SIZE);

/** Project Room use cases (ADR-030 stage 1). Authorization is the caller's job (RBAC + per-project ACL). */
export class RoomService {
  constructor(private readonly deps: RoomServiceDeps) {}

  room(projectId: string): Promise<Conversation> {
    return this.deps.conversations.ensureRoom(projectId);
  }

  async post(input: PostMessageInput): Promise<{ message: ConversationMessage; created: boolean }> {
    const parsed = PostMessageInputSchema.parse(input);
    const body = sanitizeMessageBody(parsed.body);
    if (!body) throw new RoomError('empty_body', 'message body is empty');
    const room = await this.deps.conversations.ensureRoom(parsed.projectId);

    let threadId: string | null = null;
    if (parsed.threadId) {
      const root = await this.deps.messages.get(parsed.threadId);
      if (!root || root.conversationId !== room.id) throw new RoomError('thread_not_found', 'thread not found');
      // Threads are one level deep: a reply to a reply joins the root's thread.
      threadId = root.threadId ?? root.id;
    }
    if (parsed.intent === 'answer' && !threadId) throw new RoomError('answer_requires_thread', 'an answer must reply to a thread');

    const result = await this.deps.messages.append({
      conversationId: room.id,
      projectId: parsed.projectId,
      threadId,
      authorType: parsed.author.type,
      authorId: parsed.author.id,
      authorName: sanitizeInline(parsed.author.name, MAX_AUTHOR_NAME_LENGTH) || 'unknown',
      intent: parsed.intent,
      body,
      refs: parsed.refs,
      dedupeKey: parsed.dedupeKey,
    });
    if (result.created) {
      const { message } = result;
      // Content-free payload: clients load the message through the API, which applies access control again.
      await this.deps.events.emit({
        type: 'room.message',
        projectId: parsed.projectId,
        taskId: null,
        runId: null,
        payload: {
          conversationId: room.id,
          messageId: message.id,
          seq: message.seq,
          threadId: message.threadId,
          authorType: message.authorType,
          authorName: message.authorName,
          intent: message.intent,
        },
      });
    }
    return result;
  }

  /** Top-level messages, oldest first within the window. */
  async list(projectId: string, window: { before?: number; after?: number; limit?: number } = {}): Promise<MessagePage> {
    const conversation = await this.deps.conversations.ensureRoom(projectId);
    const limit = pageSize(window.limit);
    const rows = await this.deps.messages.listTopLevel(conversation.id, {
      ...(window.before !== undefined ? { before: window.before } : {}),
      ...(window.after !== undefined ? { after: window.after } : {}),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    // Newest-first windows drop the oldest extra row; `after` windows drop the newest.
    const messages = hasMore ? (window.after !== undefined ? rows.slice(0, limit) : rows.slice(1)) : rows;
    return { conversation, messages, hasMore };
  }

  /** A thread root and its replies after `after`, oldest first. Null when the message is not in the project's room. */
  async thread(projectId: string, messageId: string, window: { after?: number; limit?: number } = {}): Promise<ThreadPage | null> {
    const conversation = await this.deps.conversations.ensureRoom(projectId);
    const message = await this.deps.messages.get(messageId);
    if (!message || message.conversationId !== conversation.id) return null;
    const root = message.threadId ? await this.deps.messages.get(message.threadId) : message;
    if (!root) return null;
    const limit = pageSize(window.limit);
    const rows = await this.deps.messages.listThread(root.id, { ...(window.after !== undefined ? { after: window.after } : {}), limit: limit + 1 });
    return { root, replies: rows.slice(0, limit), hasMore: rows.length > limit };
  }
}
