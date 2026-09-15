import { systemClock, type Clock } from '../ports';
import type {
  Conversation,
  ConversationMessage,
  ConversationMessageRepository,
  ConversationRepository,
  NewConversationMessage,
} from '../room/types';

const clone = <T>(value: T): T => structuredClone(value);

/** In-memory conversation store with the semantics of the Drizzle repositories (one room per project, dedupe keys). */
export function createMemoryConversationStore(clock: Clock = systemClock) {
  let counter = 0;
  let seq = 0;
  const conversationMap = new Map<string, Conversation>();
  const messageList: Array<ConversationMessage & { dedupeKey: string | null }> = [];
  const strip = ({ dedupeKey: _dedupeKey, ...message }: ConversationMessage & { dedupeKey: string | null }): ConversationMessage => clone(message);

  const conversations: ConversationRepository = {
    ensureRoom: async (projectId) => {
      const existing = [...conversationMap.values()].find((c) => c.kind === 'room' && c.projectId === projectId);
      if (existing) return clone(existing);
      const now = clock.now();
      const room: Conversation = {
        id: `cnv_${(++counter).toString(36).padStart(6, '0')}`,
        projectId,
        kind: 'room',
        title: 'Project room',
        status: 'active',
        createdBy: null,
        messageCount: 0,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      };
      conversationMap.set(room.id, room);
      return clone(room);
    },
    get: async (id) => clone(conversationMap.get(id) ?? null),
  };

  const messages: ConversationMessageRepository & { all(): ConversationMessage[] } = {
    all: () => messageList.map(strip),
    append: async (input: NewConversationMessage) => {
      if (input.dedupeKey) {
        const existing = messageList.find((m) => m.conversationId === input.conversationId && m.dedupeKey === input.dedupeKey);
        if (existing) return { message: strip(existing), created: false };
      }
      const now = clock.now();
      const message = { ...clone(input), id: `msg_${(++counter).toString(36).padStart(6, '0')}`, seq: ++seq, replyCount: 0, lastReplyAt: null, createdAt: now };
      messageList.push(message);
      if (message.threadId) {
        const root = messageList.find((m) => m.id === message.threadId);
        if (root) {
          root.replyCount++;
          root.lastReplyAt = now;
        }
      }
      const conversation = conversationMap.get(input.conversationId);
      if (conversation) {
        conversation.messageCount++;
        conversation.lastActivityAt = now;
        conversation.updatedAt = now;
      }
      return { message: strip(message), created: true };
    },
    get: async (id) => {
      const message = messageList.find((m) => m.id === id);
      return message ? strip(message) : null;
    },
    listTopLevel: async (conversationId, window) => {
      const top = messageList.filter((m) => m.conversationId === conversationId && m.threadId === null);
      if (window.after !== undefined) return top.filter((m) => m.seq > window.after!).slice(0, window.limit).map(strip);
      const older = window.before !== undefined ? top.filter((m) => m.seq < window.before!) : top;
      return older.slice(-window.limit).map(strip);
    },
    listThread: async (threadId, window) =>
      messageList
        .filter((m) => m.threadId === threadId && (window.after === undefined || m.seq > window.after))
        .slice(0, window.limit)
        .map(strip),
  };

  return { conversations, messages };
}
