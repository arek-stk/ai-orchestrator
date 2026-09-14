import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { defaultProjectProfile, defaultProjectSettings, RoomService, type EmitEvent, type NewConversationMessage } from '@orch/core';
import { createDatabase, type DatabaseHandle } from './client';
import { createConversationRepositories, type ConversationRepositories } from './conversation-repositories';
import { createRepositories, type Repositories } from './repositories';

let handle: DatabaseHandle;
let repos: Repositories;
let store: ConversationRepositories;

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
  store = createConversationRepositories(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function makeProject(slug: string) {
  return repos.projects.create({
    slug,
    name: slug,
    description: '',
    repo: null,
    priority: 5,
    autonomyLevel: 1,
    budgetUsd: 10,
    profile: defaultProjectProfile(),
    settings: defaultProjectSettings(),
  });
}

const message = (conversationId: string, projectId: string, overrides: Partial<NewConversationMessage> = {}): NewConversationMessage => ({
  conversationId,
  projectId,
  threadId: null,
  authorType: 'human',
  authorId: null,
  authorName: 'alice',
  intent: 'message',
  body: 'hello',
  refs: {},
  dedupeKey: null,
  ...overrides,
});

describe('conversation repositories (PGlite)', () => {
  it('creates exactly one room per project, also under concurrent first use', async () => {
    const project = await makeProject('room-once');
    const rooms = await Promise.all([1, 2, 3, 4].map(() => store.conversations.ensureRoom(project.id)));
    expect(new Set(rooms.map((r) => r.id)).size).toBe(1);
    expect(rooms[0]).toMatchObject({ kind: 'room', projectId: project.id, status: 'active', messageCount: 0 });
    const other = await makeProject('room-other');
    expect((await store.conversations.ensureRoom(other.id)).id).not.toBe(rooms[0]!.id);
    expect(await store.conversations.get(rooms[0]!.id)).toMatchObject({ id: rooms[0]!.id });
  });

  it('appends messages, deduplicates by key and counts replies atomically', async () => {
    const project = await makeProject('room-append');
    const room = await store.conversations.ensureRoom(project.id);
    const first = await store.messages.append(message(room.id, project.id, { authorType: 'orchestrator', intent: 'status', body: 'Started', dedupeKey: 'run:1:started', refs: { runId: 'run_1' } }));
    const again = await store.messages.append(message(room.id, project.id, { authorType: 'orchestrator', intent: 'status', body: 'Started', dedupeKey: 'run:1:started' }));
    expect(first.created).toBe(true);
    expect(again).toEqual({ message: first.message, created: false });
    expect(first.message).toMatchObject({ refs: { runId: 'run_1' }, replyCount: 0, lastReplyAt: null });
    expect(first.message).not.toHaveProperty('dedupeKey');

    const replies = await Promise.all([1, 2, 3].map((i) => store.messages.append(message(room.id, project.id, { threadId: first.message.id, body: `reply ${i}` }))));
    const root = (await store.messages.get(first.message.id))!;
    expect(root.replyCount).toBe(3);
    expect(root.lastReplyAt).toBeInstanceOf(Date);
    expect((await store.conversations.get(room.id))!.messageCount).toBe(4);
    const thread = await store.messages.listThread(first.message.id, { limit: 10 });
    expect(new Set(thread.map((m) => m.id))).toEqual(new Set(replies.map((r) => r.message.id)));
    expect(thread.map((m) => m.seq)).toEqual([...thread.map((m) => m.seq)].sort((a, b) => a - b));
  });

  it('pages top-level messages and threads by seq', async () => {
    const project = await makeProject('room-pages');
    const room = await store.conversations.ensureRoom(project.id);
    const top: string[] = [];
    for (let i = 1; i <= 5; i++) top.push((await store.messages.append(message(room.id, project.id, { body: `m${i}` }))).message.id);
    for (let i = 1; i <= 3; i++) await store.messages.append(message(room.id, project.id, { threadId: top[0]!, body: `r${i}` }));

    const latest = await store.messages.listTopLevel(room.id, { limit: 2 });
    expect(latest.map((m) => m.body)).toEqual(['m4', 'm5']);
    const older = await store.messages.listTopLevel(room.id, { before: latest[0]!.seq, limit: 10 });
    expect(older.map((m) => m.body)).toEqual(['m1', 'm2', 'm3']);
    const newer = await store.messages.listTopLevel(room.id, { after: older[0]!.seq, limit: 2 });
    expect(newer.map((m) => m.body)).toEqual(['m2', 'm3']);

    const thread = await store.messages.listThread(top[0]!, { limit: 2 });
    expect(thread.map((m) => m.body)).toEqual(['r1', 'r2']);
    expect((await store.messages.listThread(top[0]!, { after: thread[1]!.seq, limit: 2 })).map((m) => m.body)).toEqual(['r3']);
  });

  it('removes the room with its project', async () => {
    const project = await makeProject('room-cascade');
    const room = await store.conversations.ensureRoom(project.id);
    await store.messages.append(message(room.id, project.id));
    await handle.db.execute(sql`delete from projects where id = ${project.id}`);
    expect(await store.conversations.get(room.id)).toBeNull();
  });

  it('backs the room service end to end', async () => {
    const project = await makeProject('room-service');
    const emitted: EmitEvent[] = [];
    const service = new RoomService({ ...store, events: { emit: async (event) => void emitted.push(event) } });
    const posted = await service.post({ projectId: project.id, author: { type: 'human', id: 'usr_1', name: 'alice' }, intent: 'question', body: 'Ready?' });
    await service.post({ projectId: project.id, author: { type: 'human', id: 'usr_2', name: 'bob' }, intent: 'answer', body: 'Yes', threadId: posted.message.id });
    const page = await service.list(project.id);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ body: 'Ready?', replyCount: 1 });
    expect((await service.thread(project.id, posted.message.id))!.replies.map((m) => m.authorName)).toEqual(['bob']);
    expect(emitted.map((e) => e.type)).toEqual(['room.message', 'room.message']);
  });
});
