import { z } from 'zod';

// Unified conversation model (ADR-030 addendum): the Project Room is one conversation per project; planning sessions,
// explanations and council transcripts become further conversation kinds on the same tables later.

export const CONVERSATION_KINDS = ['room', 'planning', 'refine', 'explain', 'ask', 'council'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_STATUSES = ['active', 'archived'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_AUTHOR_TYPES = ['human', 'assistant', 'orchestrator', 'agent', 'external_ai', 'system'] as const;
export type MessageAuthorType = (typeof MESSAGE_AUTHOR_TYPES)[number];

/** ADR-030 intents plus the notices the orchestrator posts and the intents reserved for the planning assistant. */
export const MESSAGE_INTENTS = [
  'message',
  'question',
  'answer',
  'status',
  'decision',
  'decision_request',
  'claim',
  'release',
  'handoff',
  'objection',
  'clarifying_question',
  'brief_update',
  'suggestion',
] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

/** What a human may post through the API in stage 1; claims, handoffs and objections need leases and the council. */
export const HUMAN_MESSAGE_INTENTS = ['message', 'question', 'answer'] as const satisfies readonly MessageIntent[];
export type HumanMessageIntent = (typeof HUMAN_MESSAGE_INTENTS)[number];

export const MAX_MESSAGE_LENGTH = 8000;
export const MAX_AUTHOR_NAME_LENGTH = 100;
export const MAX_DEDUPE_KEY_LENGTH = 200;

const Id = z.string().min(1).max(100);

export const MessageRefsSchema = z
  .object({
    taskId: Id.optional(),
    runId: Id.optional(),
    decisionId: Id.optional(),
    approvalId: Id.optional(),
    conversationId: Id.optional(),
    workflowId: Id.optional(),
    workflowRunId: Id.optional(),
    stage: z.string().min(1).max(40).optional(),
    paths: z.array(z.string().min(1).max(300)).max(20).optional(),
  })
  .strict();
export type MessageRefs = z.infer<typeof MessageRefsSchema>;

export const MessageAuthorSchema = z.object({
  type: z.enum(MESSAGE_AUTHOR_TYPES),
  id: Id.nullable(),
  name: z.string().trim().min(1).max(MAX_AUTHOR_NAME_LENGTH),
});
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

/** Input of RoomService.post. The body is untrusted raw text; it is sanitised and redacted before storage. */
export const PostMessageInputSchema = z.object({
  projectId: Id,
  author: MessageAuthorSchema,
  intent: z.enum(MESSAGE_INTENTS),
  // Raw input may be a little longer than the stored limit (secrets and control characters are removed first).
  body: z.string().max(MAX_MESSAGE_LENGTH * 2),
  threadId: Id.nullable().default(null),
  refs: MessageRefsSchema.default({}),
  dedupeKey: z.string().min(1).max(MAX_DEDUPE_KEY_LENGTH).nullable().default(null),
});
export type PostMessageInput = z.input<typeof PostMessageInputSchema>;

export interface Conversation {
  id: string;
  projectId: string | null;
  kind: ConversationKind;
  title: string;
  status: ConversationStatus;
  createdBy: string | null;
  messageCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessage {
  id: string;
  /** Monotonic insertion order; the pagination cursor. */
  seq: number;
  conversationId: string;
  projectId: string | null;
  /** Root message id for replies; null for top-level messages. */
  threadId: string | null;
  authorType: MessageAuthorType;
  authorId: string | null;
  authorName: string;
  intent: MessageIntent;
  /** Plain text, sanitised and redacted. Never rendered as HTML. */
  body: string;
  refs: MessageRefs;
  replyCount: number;
  lastReplyAt: Date | null;
  createdAt: Date;
}

export interface NewConversationMessage {
  conversationId: string;
  projectId: string | null;
  threadId: string | null;
  authorType: MessageAuthorType;
  authorId: string | null;
  authorName: string;
  intent: MessageIntent;
  body: string;
  refs: MessageRefs;
  dedupeKey: string | null;
}

export interface MessageWindow {
  /** Messages with seq < before (newest first window). */
  before?: number;
  /** Messages with seq > after (oldest first window). */
  after?: number;
  limit: number;
}

export interface ConversationRepository {
  /** The project's room, created on first use; one room per project even under concurrent calls. */
  ensureRoom(projectId: string): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
}

export interface ConversationMessageRepository {
  /**
   * Appends a message. With a dedupe key an existing message with the same key in the conversation is returned with
   * `created: false`. Replies update the root's reply count and the conversation's activity atomically.
   */
  append(message: NewConversationMessage): Promise<{ message: ConversationMessage; created: boolean }>;
  get(id: string): Promise<ConversationMessage | null>;
  /** Top-level messages in ascending seq order. Without `after` the window is the newest `limit` messages. */
  listTopLevel(conversationId: string, window: MessageWindow): Promise<ConversationMessage[]>;
  /** Replies of a thread in ascending seq order, starting after `after`. */
  listThread(threadId: string, window: Omit<MessageWindow, 'before'>): Promise<ConversationMessage[]>;
}
