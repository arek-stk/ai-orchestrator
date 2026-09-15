'use client';

import { ArrowDown, Bot, Info, MessagesSquare, Plug, Reply, Send, User, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLiveEvents } from '@/hooks/use-live-events';
import { api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';
import {
  MAX_MESSAGE_LENGTH,
  type ConversationMessage,
  type DomainEvent,
  type HumanMessageIntent,
  type MessageAuthorType,
  type RoomMessagesResponse,
  type RoomThreadResponse,
} from '@/lib/types';
import { hasRole, useSession } from './providers';
import { Button, Card, Chip, cx, EmptyState, ErrorBanner, IconButton, Loading, OrchestratorMark, RelativeTime, TextLink, textareaClass } from './ui';

// Project Room (ADR-030 stage 1). Message bodies are untrusted plain text: rendered as React text nodes (never HTML),
// with http(s) links turned into anchors that open in a new tab without referrer or opener.

const PAGE_SIZE = 50;
const MAX_SYNC_PAGES = 5;
const NEAR_BOTTOM_PX = 48;

// ---------------------------------------------------------------------------
// Plain text with safe links
// ---------------------------------------------------------------------------

// One character class after a fixed prefix: linear time, no nested quantifiers.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = '.,;:!?)]}\'"';

export interface TextPart {
  text: string;
  href?: string;
}

export function linkifyText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    while (candidate.length > 0 && TRAILING_PUNCTUATION.includes(candidate[candidate.length - 1]!)) candidate = candidate.slice(0, -1);
    let href: string | null = null;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
    } catch {
      href = null;
    }
    if (!href) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: candidate, href });
    cursor = start + candidate.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

function MessageText({ text }: { text: string }) {
  const parts = useMemo(() => linkifyText(text), [text]);
  return (
    <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">
      {parts.map((part, index) =>
        part.href ? (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-link underline underline-offset-2">
            {part.text}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

const AUTHOR_LABEL: Record<MessageAuthorType, string> = {
  human: 'Person',
  assistant: 'Assistant',
  orchestrator: 'Orchestrator',
  agent: 'Agent',
  external_ai: 'External AI',
  system: 'System',
};

const AUTHOR_ICON: Record<Exclude<MessageAuthorType, 'orchestrator'>, LucideIcon> = {
  human: User,
  assistant: Bot,
  agent: Bot,
  external_ai: Plug,
  system: Info,
};

const INTENT_LABEL: Partial<Record<string, string>> = { decision_request: 'Approval needed', clarifying_question: 'Clarifying question' };

const isAutomatic = (message: ConversationMessage) => message.authorType === 'orchestrator' || message.authorType === 'agent' || message.authorType === 'system';

function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]): ConversationMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function AuthorAvatar({ type }: { type: MessageAuthorType }) {
  if (type === 'orchestrator') {
    return (
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <OrchestratorMark size={16} />
      </span>
    );
  }
  const Icon = AUTHOR_ICON[type];
  return (
    <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', type === 'human' ? 'bg-surface-2 text-ink-2' : 'bg-surface-2 text-muted')}>
      <Icon aria-hidden="true" size={14} />
    </span>
  );
}

function MessageRefLinks({ message }: { message: ConversationMessage }) {
  const { refs } = message;
  const items: ReactNode[] = [];
  if (refs.stage) items.push(<Chip key="stage">{refs.stage}</Chip>);
  if (refs.runId) {
    items.push(
      <TextLink key="run" href={`/runs/${encodeURIComponent(refs.runId)}`} className="text-xs">
        View run
      </TextLink>,
    );
  }
  if (refs.approvalId) {
    items.push(
      <TextLink key="approval" href="/approvals" className="text-xs">
        Open approvals
      </TextLink>,
    );
  }
  if (refs.decisionId) {
    items.push(
      <TextLink key="decision" href="/decisions" className="text-xs">
        Decisions
      </TextLink>,
    );
  }
  if (items.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">{items}</div>;
}

function RoomMessage({
  message,
  threadControl,
}: {
  message: ConversationMessage;
  threadControl?: ReactNode;
}) {
  const intentLabel = message.intent === 'message' ? null : (INTENT_LABEL[message.intent] ?? humanize(message.intent));

  if (message.authorType === 'system') {
    return (
      <div className="flex items-start gap-2.5 px-3 py-1.5 text-ink-2">
        <Info aria-hidden="true" size={14} className="mt-[3px] shrink-0 text-muted" />
        <div className="min-w-0 flex-1 text-[13px] [&_p]:text-ink-2">
          <span className="sr-only">System notice: </span>
          <MessageText text={message.body} />
          <MessageRefLinks message={message} />
        </div>
        <RelativeTime value={message.createdAt} className="tabular shrink-0 text-xs text-muted" />
      </div>
    );
  }

  const automatic = message.authorType !== 'human';
  return (
    <div
      className={cx(
        'flex items-start gap-2.5 rounded-lg px-3 py-2.5',
        message.intent === 'decision_request' ? 'border-l-2 border-warning bg-warning-soft' : automatic ? 'border-l-2 border-accent/60 bg-accent-soft/40' : 'bg-surface',
        message.authorType === 'external_ai' && 'border-l-2 border-serious bg-serious-soft/40',
      )}
    >
      <AuthorAvatar type={message.authorType} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-ink">{message.authorName}</span>
          {message.authorType !== 'human' ? <Chip>{AUTHOR_LABEL[message.authorType]}</Chip> : null}
          {intentLabel ? <Chip className={message.intent === 'decision_request' ? 'border-warning/50 text-ink' : undefined}>{intentLabel}</Chip> : null}
          <RelativeTime value={message.createdAt} className="tabular text-xs text-ink-2" />
        </div>
        <div className="mt-1">
          <MessageText text={message.body} />
        </div>
        <MessageRefLinks message={message} />
        {threadControl ? <div className="mt-1.5">{threadControl}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({
  label,
  placeholder,
  intents,
  onSend,
  autoFocus,
}: {
  label: string;
  placeholder: string;
  intents: ReadonlyArray<{ value: HumanMessageIntent; label: string }>;
  onSend: (body: string, intent: HumanMessageIntent) => Promise<boolean>;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<HumanMessageIntent>(intents[0]!.value);
  const [sending, setSending] = useState(false);
  const tooLong = draft.length > MAX_MESSAGE_LENGTH;
  const empty = draft.trim().length === 0;

  const submit = async () => {
    if (sending || empty || tooLong) return;
    setSending(true);
    try {
      if (await onSend(draft, intent)) {
        setDraft('');
        setIntent(intents[0]!.value);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line; never while an IME composition is active.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-body`} className="sr-only">
        {label}
      </label>
      <textarea
        id={`${id}-body`}
        rows={2}
        value={draft}
        autoFocus={autoFocus}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-describedby={`${id}-hint`}
        aria-invalid={tooLong || undefined}
        className={cx(textareaClass, 'min-h-[60px] resize-y')}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-hint`} className={cx('text-xs', tooLong ? 'text-critical' : 'text-ink-2')}>
          {draft.length > MAX_MESSAGE_LENGTH - 1000 ? `${draft.length.toLocaleString()} / ${MAX_MESSAGE_LENGTH.toLocaleString()} characters. ` : ''}
          Enter to send, Shift+Enter for a new line. Plain text; links open in a new tab.
        </p>
        <div className="flex items-center gap-2">
          {intents.length > 1 ? (
            <>
              <label htmlFor={`${id}-intent`} className="sr-only">
                Message type
              </label>
              <select id={`${id}-intent`} value={intent} onChange={(event) => setIntent(event.target.value as HumanMessageIntent)} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px] text-ink">
                {intents.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <Button type="submit" variant="primary" icon={Send} busy={sending} disabled={empty || tooLong}>
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Live room events
// ---------------------------------------------------------------------------

/**
 * Calls `onBatch` with the room events that arrived since the last call (thread root ids and whether top-level
 * messages arrived), coalesced over a short delay. Events already in the buffer on mount are ignored: the initial
 * fetch covers them. A reconnect after an outage triggers a full resync.
 */
function useRoomEvents(projectId: string, onBatch: (batch: { topLevel: boolean; threads: Set<string>; resync: boolean }) => void) {
  const filter = useCallback((event: DomainEvent) => event.type === 'room.message' && event.projectId === projectId, [projectId]);
  const { events, state } = useLiveEvents(filter);
  const seen = useRef<Set<string> | null>(null);
  const pending = useRef({ topLevel: false, threads: new Set<string>(), resync: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callback = useRef(onBatch);
  const previousState = useRef(state);
  useEffect(() => {
    callback.current = onBatch;
  });

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const batch = pending.current;
      pending.current = { topLevel: false, threads: new Set(), resync: false };
      callback.current(batch);
    }, 200);
  }, []);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(events.map((e) => e.id ?? ''));
      return;
    }
    let changed = false;
    for (const event of events) {
      const key = event.id ?? `${event.createdAt}-${String(event.payload.messageId)}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      changed = true;
      const threadId = event.payload.threadId;
      if (typeof threadId === 'string') pending.current.threads.add(threadId);
      else pending.current.topLevel = true;
    }
    if (seen.current.size > 1000) seen.current = new Set([...seen.current].slice(-500));
    if (changed) schedule();
  }, [events, schedule]);

  useEffect(() => {
    const before = previousState.current;
    previousState.current = state;
    if (state === 'open' && (before === 'reconnecting' || before === 'offline')) {
      pending.current.resync = true;
      schedule();
    }
  }, [state, schedule]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}

// ---------------------------------------------------------------------------
// Thread panel
// ---------------------------------------------------------------------------

function ThreadPanel({
  projectId,
  rootId,
  canPost,
  onClose,
  onRootChanged,
}: {
  projectId: string;
  rootId: string;
  canPost: boolean;
  onClose: () => void;
  onRootChanged: (root: ConversationMessage) => void;
}) {
  const headingId = useId();
  const url = `/api/projects/${encodeURIComponent(projectId)}/room/messages/${encodeURIComponent(rootId)}/replies`;
  const [root, setRoot] = useState<ConversationMessage | null>(null);
  const [replies, setReplies] = useState<ConversationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const repliesRef = useRef<ConversationMessage[]>([]);
  const listRef = useRef<HTMLOListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootChanged = useRef(onRootChanged);
  useEffect(() => {
    rootChanged.current = onRootChanged;
  });

  const load = useCallback(
    async (mode: 'initial' | 'newer') => {
      try {
        let after = mode === 'newer' ? repliesRef.current.at(-1)?.seq : undefined;
        for (let page = 0; page < MAX_SYNC_PAGES; page++) {
          const result = await api<RoomThreadResponse>(`${url}?limit=100${after !== undefined ? `&after=${after}` : ''}`);
          repliesRef.current = mergeMessages(page === 0 && mode === 'initial' ? [] : repliesRef.current, result.replies);
          setReplies(repliesRef.current);
          setRoot(result.root);
          rootChanged.current(result.root);
          if (!result.hasMore) break;
          after = repliesRef.current.at(-1)?.seq;
        }
        setError(null);
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [url],
  );

  useEffect(() => {
    repliesRef.current = [];
    setReplies([]);
    setRoot(null);
    void load('initial');
    headingRef.current?.focus();
  }, [load]);

  useRoomEvents(projectId, (batch) => {
    if (batch.resync || batch.threads.has(rootId)) void load('newer');
  });

  const send = async (body: string, intent: HumanMessageIntent) => {
    try {
      await api(url, { method: 'POST', body: { body, intent } });
      setPostError(null);
      await load('newer');
      return true;
    } catch (err) {
      setPostError(errorMessage(err));
      return false;
    }
  };

  return (
    <aside
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className="flex min-w-0 flex-col rounded-[10px] border border-line bg-surface lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-96px)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-[13px] font-semibold text-ink outline-none">
          Thread{root ? ` · ${root.replyCount} ${root.replyCount === 1 ? 'reply' : 'replies'}` : ''}
        </h2>
        <IconButton icon={X} label="Close thread" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <ErrorBanner error={error} onRetry={() => void load('initial')} />
        {!root && !error ? <Loading label="Loading thread" /> : null}
        {root ? (
          <>
            <div className="rounded-lg border border-line">
              <RoomMessage message={root} />
            </div>
            <ol ref={listRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Replies" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {replies.length === 0 ? <li className="px-3 py-2 text-[13px] text-ink-2">No replies yet.</li> : null}
              {replies.map((reply) => (
                <li key={reply.id}>
                  <RoomMessage message={reply} />
                </li>
              ))}
            </ol>
          </>
        ) : null}
        {canPost && root ? (
          <div className="border-t border-line pt-3">
            <ErrorBanner error={postError} onDismiss={() => setPostError(null)} className="mb-2" />
            <Composer
              label="Reply"
              placeholder="Reply in thread…"
              intents={[
                { value: 'message', label: 'Reply' },
                { value: 'answer', label: 'Answer' },
              ]}
              onSend={send}
            />
          </div>
        ) : null}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Room tab
// ---------------------------------------------------------------------------

export function RoomTab({ projectId }: { projectId: string }) {
  const { user } = useSession();
  const canPost = hasRole(user, 'operator');
  const base = `/api/projects/${encodeURIComponent(projectId)}/room/messages`;

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [showUpdates, setShowUpdates] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [openThread, setOpenThread] = useState<string | null>(null);

  const messagesRef = useRef<ConversationMessage[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const scrollAction = useRef<{ kind: 'bottom' } | { kind: 'preserve'; height: number; top: number } | null>(null);
  const threadTrigger = useRef<HTMLElement | null>(null);
  const threadPanelId = useId();

  const apply = useCallback((next: ConversationMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const loadLatest = useCallback(async () => {
    try {
      const page = await api<RoomMessagesResponse>(`${base}?limit=${PAGE_SIZE}`);
      scrollAction.current = { kind: 'bottom' };
      apply(page.messages);
      setHasOlder(page.hasMore);
      setError(null);
      setUnseen(0);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [apply, base]);

  useEffect(() => {
    apply([]);
    setLoaded(false);
    setOpenThread(null);
    void loadLatest();
  }, [apply, loadLatest]);

  /** Fetches top-level messages newer than the newest loaded one (bounded pages); a gap too large reloads. */
  const syncNewer = useCallback(async () => {
    const last = messagesRef.current.at(-1)?.seq;
    if (last === undefined) return loadLatest();
    try {
      let after = last;
      let added = 0;
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const result = await api<RoomMessagesResponse>(`${base}?limit=100&after=${after}`);
        const before = messagesRef.current.length;
        const next = mergeMessages(messagesRef.current, result.messages);
        added += next.length - before;
        if (atBottom.current) scrollAction.current = { kind: 'bottom' };
        apply(next);
        if (!result.hasMore) return void (atBottom.current ? undefined : setUnseen((n) => n + added));
        after = next.at(-1)!.seq;
      }
      await loadLatest();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [apply, base, loadLatest]);

  const refreshRoots = useCallback(
    async (rootIds: string[]) => {
      const loadedIds = new Set(messagesRef.current.map((m) => m.id));
      const results = await Promise.allSettled(
        rootIds
          .filter((id) => loadedIds.has(id))
          .slice(0, 10)
          .map((id) => api<RoomThreadResponse>(`${base}/${encodeURIComponent(id)}/replies?limit=1`)),
      );
      const roots = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.root] : []));
      if (roots.length > 0) apply(mergeMessages(messagesRef.current, roots));
    },
    [apply, base],
  );

  useRoomEvents(projectId, (batch) => {
    if (!loaded) return;
    if (batch.resync || batch.topLevel) void syncNewer();
    if (batch.threads.size > 0) void refreshRoots([...batch.threads]);
  });

  const loadOlder = async () => {
    const first = messagesRef.current[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<RoomMessagesResponse>(`${base}?limit=${PAGE_SIZE}&before=${first.seq}`);
      const list = listRef.current;
      if (list) scrollAction.current = { kind: 'preserve', height: list.scrollHeight, top: list.scrollTop };
      apply(mergeMessages(messagesRef.current, page.messages));
      setHasOlder(page.hasMore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const visible = useMemo(() => (showUpdates ? messages : messages.filter((m) => !isAutomatic(m))), [messages, showUpdates]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const action = scrollAction.current;
    scrollAction.current = null;
    if (!list || !action) return;
    if (action.kind === 'bottom') {
      list.scrollTop = list.scrollHeight;
      atBottom.current = true;
    } else {
      list.scrollTop = list.scrollHeight - action.height + action.top;
    }
  }, [visible]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom.current && unseen > 0) setUnseen(0);
  };

  const scrollToBottom = () => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    atBottom.current = true;
    setUnseen(0);
  };

  const send = async (body: string, intent: HumanMessageIntent) => {
    try {
      const { message } = await api<{ message: ConversationMessage }>(base, { method: 'POST', body: { body, intent } });
      setPostError(null);
      // The author always sees their own message, even when scrolled up.
      scrollAction.current = { kind: 'bottom' };
      apply(mergeMessages(messagesRef.current, [message]));
      setUnseen(0);
      return true;
    } catch (err) {
      setPostError(errorMessage(err));
      return false;
    }
  };

  const closeThread = () => {
    setOpenThread(null);
    threadTrigger.current?.focus();
  };

  const updateRoot = useCallback((root: ConversationMessage) => {
    if (messagesRef.current.some((m) => m.id === root.id)) apply(mergeMessages(messagesRef.current, [root]));
  }, [apply]);

  const threadControl = (message: ConversationMessage) => {
    if (message.replyCount === 0 && !canPost) return undefined;
    const open = openThread === message.id;
    return (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? threadPanelId : undefined}
        onClick={(event) => {
          threadTrigger.current = event.currentTarget;
          setOpenThread(open ? null : message.id);
        }}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-ink-2 transition-[color,background-color] duration-150 ease-out hover:bg-surface-2 hover:text-ink pointer-coarse:h-9"
      >
        <Reply aria-hidden="true" size={13} />
        {message.replyCount > 0 ? (
          <>
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            {message.lastReplyAt ? (
              <span className="font-normal">
                · last <RelativeTime value={message.lastReplyAt} />
              </span>
            ) : null}
          </>
        ) : (
          'Reply in thread'
        )}
      </button>
    );
  };

  return (
    <div className={cx('grid items-start gap-4', openThread && 'lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]')}>
      <Card
        title="Project room"
        description="People, the orchestrator and its agents in one place. Stage results, approvals and decisions appear automatically."
        actions={
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={showUpdates} onChange={(event) => setShowUpdates(event.target.checked)} />
            Show pipeline updates
          </label>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <ErrorBanner error={error} onRetry={() => void loadLatest()} />
        {!loaded ? (
          <Loading label="Loading room" rows={4} />
        ) : (
          <div className="relative">
            <div ref={listRef} onScroll={onScroll} className="max-h-[min(62vh,640px)] min-h-[160px] overflow-y-auto overscroll-contain pr-1" aria-busy={loadingOlder}>
              {hasOlder ? (
                <div className="flex justify-center pb-2">
                  <Button size="sm" variant="ghost" busy={loadingOlder} onClick={() => void loadOlder()}>
                    Load earlier messages
                  </Button>
                </div>
              ) : null}
              {visible.length === 0 && !error ? (
                <EmptyState
                  icon={MessagesSquare}
                  title={messages.length === 0 ? 'No messages yet' : 'No conversation messages'}
                  hint={
                    messages.length === 0
                      ? 'Start the conversation, or run a task: stage results, approvals and decisions show up here.'
                      : 'Only pipeline updates so far. Turn on "Show pipeline updates" to see them.'
                  }
                />
              ) : (
                <ol role="log" aria-live="polite" aria-relevant="additions" aria-label="Room messages" className="flex flex-col gap-1">
                  {visible.map((message) => (
                    <li key={message.id} className={cx(openThread === message.id && 'rounded-lg ring-1 ring-accent/50')}>
                      <RoomMessage message={message} threadControl={threadControl(message)} />
                    </li>
                  ))}
                </ol>
              )}
            </div>
            {unseen > 0 ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
                <Button size="sm" variant="primary" icon={ArrowDown} className="pointer-events-auto shadow-pop" onClick={scrollToBottom}>
                  {unseen} new {unseen === 1 ? 'message' : 'messages'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {canPost ? (
          <div className="border-t border-line pt-3">
            <ErrorBanner error={postError} onDismiss={() => setPostError(null)} className="mb-2" />
            <Composer
              label="Message"
              placeholder="Write to the room…"
              intents={[
                { value: 'message', label: 'Message' },
                { value: 'question', label: 'Question' },
              ]}
              onSend={send}
            />
          </div>
        ) : (
          <p className="border-t border-line pt-3 text-xs text-ink-2">You can read this room. Posting needs the operator role on this project.</p>
        )}
      </Card>
      {openThread ? (
        <div id={threadPanelId}>
          <ThreadPanel key={openThread} projectId={projectId} rootId={openThread} canPost={canPost} onClose={closeThread} onRootChanged={updateRoot} />
        </div>
      ) : null}
    </div>
  );
}
