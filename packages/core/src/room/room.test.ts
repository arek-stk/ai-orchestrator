import { describe, expect, it, vi } from 'vitest';
import type { AnyDomainEvent } from '../events/types';
import type { EmitEvent, EventRecorder } from '../ports';
import { createMemoryConversationStore } from '../testing/memory-conversations';
import { sanitizeInline, sanitizeMessageBody } from './content';
import { describeEventForRoom, RoomEventProjector, RunNoticeLimiter, withRoomProjection } from './projector';
import { RoomError, RoomService } from './service';
import { MAX_MESSAGE_LENGTH, PostMessageInputSchema } from './types';

const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;

function recorder(): EventRecorder & { log: EmitEvent[] } {
  const log: EmitEvent[] = [];
  return { log, emit: async (event) => void log.push(event) };
}

function setup() {
  const store = createMemoryConversationStore();
  const events = recorder();
  const room = new RoomService({ ...store, events });
  const human = { type: 'human' as const, id: 'usr_1', name: 'alice' };
  return { store, events, room, human };
}

const event = (type: string, payload: Record<string, unknown>, ids: { runId?: string | null; taskId?: string | null } = {}): EmitEvent =>
  ({ type, projectId: 'prj_1', taskId: ids.taskId ?? 'tsk_1', runId: ids.runId === undefined ? 'run_1' : ids.runId, payload }) as EmitEvent;

describe('room content', () => {
  it('strips control and bidi characters, redacts secrets and bounds the length', () => {
    expect(sanitizeMessageBody('  hello\r\nworld \u202Eevil\u0007  ')).toBe('hello\nworld evil');
    expect(sanitizeMessageBody(`token ${GITHUB_TOKEN} here`)).toBe('token [REDACTED:github_token] here');
    // A zero-width character cannot split a secret to hide it from redaction.
    expect(sanitizeMessageBody(`ghp_\u200B${'a'.repeat(36)}`)).toBe('[REDACTED:github_token]');
    expect(sanitizeMessageBody('a\n\n\n\n\n\nb')).toBe('a\n\n\nb');
    const long = sanitizeMessageBody('x'.repeat(MAX_MESSAGE_LENGTH + 500));
    expect(long).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(long.endsWith('\u2026')).toBe(true);
    expect(sanitizeInline('multi\n\nline\ttext', 100)).toBe('multi line text');
  });

  it('handles adversarial input in linear time', () => {
    const inputs = ['\n'.repeat(200_000), ' '.repeat(200_000) + 'x', `${'-----BEGIN PRIVATE KEY-----'.repeat(2000)}`, `password = "${'a'.repeat(100_000)}`];
    const started = performance.now();
    for (const input of inputs) sanitizeMessageBody(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('validates intents, authors and references with zod', () => {
    const base = { projectId: 'prj_1', author: { type: 'human', id: 'usr_1', name: 'alice' }, intent: 'message', body: 'hi' };
    expect(PostMessageInputSchema.safeParse(base).success).toBe(true);
    expect(PostMessageInputSchema.safeParse({ ...base, intent: 'shout' }).success).toBe(false);
    expect(PostMessageInputSchema.safeParse({ ...base, author: { type: 'robot', id: null, name: 'x' } }).success).toBe(false);
    expect(PostMessageInputSchema.safeParse({ ...base, refs: { taskId: 'tsk_1', script: 'x' } }).success).toBe(false);
    expect(PostMessageInputSchema.safeParse({ ...base, body: 'x'.repeat(MAX_MESSAGE_LENGTH * 2 + 1) }).success).toBe(false);
  });
});

describe('RoomService', () => {
  it('creates one room per project and emits a content-free room.message event', async () => {
    const { room, events, human } = setup();
    const { message, created } = await room.post({ projectId: 'prj_1', author: human, intent: 'question', body: `Which index? ${GITHUB_TOKEN}` });
    expect(created).toBe(true);
    expect(message).toMatchObject({ authorType: 'human', authorName: 'alice', intent: 'question', body: 'Which index? [REDACTED:github_token]', threadId: null });
    expect((await room.room('prj_1')).id).toBe(message.conversationId);
    expect((await room.room('prj_2')).id).not.toBe(message.conversationId);

    expect(events.log).toHaveLength(1);
    expect(events.log[0]).toMatchObject({ type: 'room.message', projectId: 'prj_1', runId: null, payload: { messageId: message.id, seq: message.seq, intent: 'question' } });
    expect(JSON.stringify(events.log[0]!.payload)).not.toContain('Which index');
  });

  it('deduplicates by key without a second event', async () => {
    const { room, events } = setup();
    const input = { projectId: 'prj_1', author: { type: 'orchestrator' as const, id: null, name: 'Orchestrator' }, intent: 'status' as const, body: 'Started', dedupeKey: 'run:1:started' };
    const first = await room.post(input);
    const second = await room.post(input);
    expect(second).toEqual({ message: first.message, created: false });
    expect(events.log).toHaveLength(1);
  });

  it('keeps threads one level deep and counts replies on the root', async () => {
    const { room, human } = setup();
    const root = (await room.post({ projectId: 'prj_1', author: human, intent: 'question', body: 'Root?' })).message;
    const reply = (await room.post({ projectId: 'prj_1', author: human, intent: 'answer', body: 'Yes', threadId: root.id })).message;
    const nested = (await room.post({ projectId: 'prj_1', author: human, intent: 'message', body: 'Nested', threadId: reply.id })).message;
    expect(reply.threadId).toBe(root.id);
    expect(nested.threadId).toBe(root.id);

    const thread = (await room.thread('prj_1', root.id))!;
    expect(thread.root.replyCount).toBe(2);
    expect(thread.replies.map((m) => m.body)).toEqual(['Yes', 'Nested']);
    expect((await room.thread('prj_1', reply.id))!.root.id).toBe(root.id);
    // Replies do not appear in the top-level list.
    expect((await room.list('prj_1')).messages.map((m) => m.id)).toEqual([root.id]);
  });

  it('rejects empty bodies, answers outside threads and threads of other projects', async () => {
    const { room, human } = setup();
    const foreign = (await room.post({ projectId: 'prj_2', author: human, intent: 'message', body: 'Other project' })).message;
    await expect(room.post({ projectId: 'prj_1', author: human, intent: 'message', body: ' \u200B \u0000 ' })).rejects.toMatchObject({ code: 'empty_body' });
    await expect(room.post({ projectId: 'prj_1', author: human, intent: 'answer', body: 'Yes' })).rejects.toBeInstanceOf(RoomError);
    await expect(room.post({ projectId: 'prj_1', author: human, intent: 'message', body: 'Hi', threadId: foreign.id })).rejects.toMatchObject({ code: 'thread_not_found' });
    expect(await room.thread('prj_1', foreign.id)).toBeNull();
  });

  it('paginates with seq cursors in both directions', async () => {
    const { room, human } = setup();
    for (let i = 1; i <= 5; i++) await room.post({ projectId: 'prj_1', author: human, intent: 'message', body: `m${i}` });
    const latest = await room.list('prj_1', { limit: 2 });
    expect(latest.messages.map((m) => m.body)).toEqual(['m4', 'm5']);
    expect(latest.hasMore).toBe(true);
    const older = await room.list('prj_1', { limit: 2, before: latest.messages[0]!.seq });
    expect(older.messages.map((m) => m.body)).toEqual(['m2', 'm3']);
    const oldest = await room.list('prj_1', { limit: 2, before: older.messages[0]!.seq });
    expect(oldest).toMatchObject({ hasMore: false });
    expect(oldest.messages.map((m) => m.body)).toEqual(['m1']);
    const newer = await room.list('prj_1', { limit: 2, after: oldest.messages[0]!.seq });
    expect(newer.messages.map((m) => m.body)).toEqual(['m2', 'm3']);
    expect(newer.hasMore).toBe(true);
  });
});

describe('room projection of orchestrator events', () => {
  it('maps only allow-listed events to typed notices', () => {
    const now = new Date();
    expect(describeEventForRoom(event('pipeline.stage.started', { stage: 'PLAN' }), { taskTitle: null, now })).toBeNull();
    expect(describeEventForRoom(event('agent.completed', { role: 'builder' }), { taskTitle: null, now })).toBeNull();
    expect(describeEventForRoom(event('pipeline.stage.completed', { stage: 'INTAKE', status: 'passed' }), { taskTitle: null, now })).toBeNull();
    expect(describeEventForRoom(event('pipeline.stage.completed', { stage: 'COMMIT', status: 'failed', summary: 'push rejected' }), { taskTitle: 'Search', now })).toMatchObject({
      intent: 'status',
      body: 'Stage COMMIT failed for “Search”: push rejected',
      refs: { runId: 'run_1', taskId: 'tsk_1', stage: 'COMMIT' },
    });
    expect(describeEventForRoom(event('approval.required', { approvalId: 'apr_1', action: 'db_migration', risk: 'high', reason: 'Adds a table' }), { taskTitle: null, now })).toMatchObject({
      intent: 'decision_request',
      essential: true,
      body: 'Approval needed: db migration (high risk). Adds a table',
      refs: { approvalId: 'apr_1' },
    });
    expect(describeEventForRoom(event('decision.made', { decisionId: 'dec_1', question: 'Which option?', confidence: 0.87 }), { taskTitle: null, now })).toMatchObject({
      intent: 'decision',
      body: 'Decision recorded (87% confidence): Which option?',
    });
  });

  it('redacts secrets that reach notices through agent summaries', () => {
    const notice = describeEventForRoom(event('task.blocked', { reason: `CI log leaked ${GITHUB_TOKEN}` }), { taskTitle: null, now: new Date() });
    expect(notice!.body).toBe('Blocked: CI log leaked [REDACTED:github_token]');
  });

  it('posts each notice once, limits routine notices per run and lets essential notices through', async () => {
    const { room, store } = setup();
    const projector = new RoomEventProjector({ room }, { maxNoticesPerRun: 2 });
    const started = event('task.started', { runId: 'run_1' });
    await projector.project(started);
    await projector.project(started); // at-least-once re-emission
    for (const stage of ['PLAN', 'IMPLEMENT', 'TEST', 'REVIEW']) await projector.project(event('pipeline.stage.completed', { stage, status: 'passed' }));
    await projector.project(event('approval.required', { approvalId: 'apr_1', action: 'production_deploy', risk: 'high', reason: 'Deploy' }));
    await projector.project(event('task.started', { runId: 'run_2' }, { runId: 'run_2' }));

    const bodies = store.messages.all().map((m) => m.body);
    expect(bodies.filter((b) => b.startsWith('Started'))).toHaveLength(2);
    expect(bodies).toContain('Stage PLAN passed.');
    expect(bodies.some((b) => b.startsWith('Stage IMPLEMENT'))).toBe(false);
    expect(bodies.filter((b) => b.startsWith('Further routine updates'))).toHaveLength(1);
    expect(bodies.some((b) => b.startsWith('Approval needed'))).toBe(true);
    expect(store.messages.all()).toHaveLength(5);
  });

  it('evicts the oldest runs from the limiter', () => {
    const limiter = new RunNoticeLimiter(1, 2);
    limiter.record('a', 'post');
    limiter.record('b', 'post');
    limiter.record('c', 'post');
    expect(limiter.check('a')).toBe('post');
    expect(limiter.check('c')).toBe('notice');
  });

  it('never fails the emitting step and does not project room messages', async () => {
    const onError = vi.fn();
    const inner = recorder();
    const failing = new RoomEventProjector({ room: { post: async () => Promise.reject(new Error('db down')) }, onError });
    const events = withRoomProjection(inner, failing);
    await expect(events.emit(event('task.failed', { reason: 'x' }))).resolves.toBeUndefined();
    expect(inner.log).toHaveLength(1);
    expect(onError).toHaveBeenCalledOnce();

    const post = vi.fn();
    await new RoomEventProjector({ room: { post } }).project({ ...event('room.message', {}), type: 'room.message' } as AnyDomainEvent);
    await new RoomEventProjector({ room: { post } }).project({ ...event('task.failed', { reason: 'x' }), projectId: null });
    expect(post).not.toHaveBeenCalled();
  });
});
