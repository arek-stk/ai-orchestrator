# Plan: Project Room, external AI collaboration, Kanban and project planning

Decision: ADR-030. Implementation starts after the currently open module PRs (web dashboard, platform operations,
orchestration improvements) are merged, because it touches database, server, core and web at once.

## Goals

1. Humans (owner, colleagues, friends) and their own AI assistants work on the same project with the orchestrator.
2. A shared, live **Project Room** per project with typed messages, not free-form agent chatter.
3. **External AIs** (Claude Code, Copilot, Cursor, …) join through an **MCP server** with their own identity and rights.
4. **Leases** prevent two actors from changing the same task or code area concurrently.
5. **Kanban board, milestones and roadmap** as views and planning tools over the existing task system.

Non-goals (this round): video/voice, direct messages between users, GitHub Projects sync (stage 4), real-time
co-editing of files, AI agents outside the orchestrator making decisions.

## Data model (migration after the current schema owner's `0001`)

| Table / change | Fields |
|---|---|
| `room_messages` | `id`, `project_id`, `author_type` (`human`, `orchestrator`, `agent`, `external_ai`, `system`), `author_id`, `intent` (`message`, `claim`, `release`, `handoff`, `question`, `objection`, `status`, `decision_request`), `body` (≤ 8 000 chars), `refs` jsonb `{taskId?, runId?, decisionId?, paths?[]}`, `reply_to`, `created_at` |
| `ai_identities` | `id`, `name`, `owner_user_id`, `token_hash`, `scopes` jsonb, `project_ids` jsonb, `last_seen_at`, `revoked_at`, `created_at` |
| `leases` | `id`, `project_id`, `holder_type` (`user`, `external_ai`, `orchestrator`), `holder_id`, `scope` (`task`, `paths`), `task_id`, `path_globs` jsonb, `reason`, `expires_at`, `heartbeat_at`, `created_at` |
| `milestones` | `id`, `project_id`, `title`, `description`, `due_date`, `status` (`planned`, `active`, `done`), `position`, `created_at` |
| `tasks` (new columns) | `assignee_type` (`orchestrator` default, `user`, `external_ai`), `assignee_id`, `milestone_id`, `board_position` (float for cheap reordering), `estimate_points`, `labels` jsonb, `due_date` |

## Core (IO-free)

- `leases.ts`: overlap detection between path globs and change sets, expiry, conflict reasons.
- Scheduler: skip tasks whose assignee is not the orchestrator; skip tasks with foreign task leases.
- Pipeline: before IMPLEMENT and COMMIT, check path leases of other holders against the plan areas / change set →
  `wait` with reason and resume when the lease expires or is released (bounded by stop conditions).
- `board.ts`: column mapping and allowed transitions:
  `Backlog ↔ Ready` (humans), `Blocked → Ready` (retry), `* → Cancelled`; "In progress" (RUNNING, WAITING_*),
  "Review" (PR open / approval pending) and "Done" are controlled by the pipeline for orchestrator-owned tasks and
  by the assignee for human/external-AI tasks. WIP limit per column = project `maxConcurrentTasks` for In progress.
- Planning agent extension: `roadmap_output` schema (milestones → epics → tasks with dependencies, estimates,
  risks) with verify checks (no cycles, every task in a milestone, estimates within bounds). Output is a proposal;
  a human accepts it before tasks are created.
- Room commands parser: `@orchestrator status`, `@orchestrator plan <goal>`, `@orchestrator create task …`,
  `@orchestrator approve|reject <approval>` → mapped to existing use cases with RBAC checks. Status answers use the
  fast model tier and cached project state.
- Objections: an `objection` message referencing a decision becomes an extra council input (max 1 additional round);
  the orchestrator records the outcome as a new decision superseding the old one or a reply explaining why not.

## Server

- Routes: room messages (list with cursor, post), leases (list, acquire, heartbeat, release), board (move with
  optimistic ordering), milestones CRUD, roadmap proposal (generate, accept), AI identities (create → token shown
  once, revoke, scopes).
- SSE events: `room.message`, `task.assigned`, `task.moved`, `lease.acquired`, `lease.released`, `lease.expired`,
  `milestone.updated`, `roadmap.proposed`.
- **MCP server** (Streamable HTTP at `/mcp`, bearer token of an AI identity): tools `list_tasks`, `get_task`,
  `get_context` (plan, decision, relevant files via context builder, redacted), `claim_task`, `release_task`,
  `acquire_paths`, `report_progress`, `post_message`, `request_review`, `raise_objection`, `list_decisions`.
  Resources: project summary, board. Every call checks identity scopes + project ACL, is rate limited and audited.
- Lease reaper in the scheduler tick; expired leases emit events and post a system message.

## Web

- Project tabs: **Board** (columns, drag & drop with keyboard alternative, WIP indicator, assignee avatars incl. AI
  identities, filters by milestone/label/assignee), **Roadmap** (milestones timeline, dependency layers, estimates,
  capacity), **Room** (live chat with intents as chips, references rendered as task/run/decision cards, `@orchestrator`
  autocomplete, approval actions inline for authorised users, lease banner "Carol's Copilot is editing src/auth/**").
- Settings → **AI identities**: create/revoke, scopes, projects, copy MCP connection snippet for Claude Code, Copilot
  and Cursor.

## Security

- External AI content is untrusted data: never executed, never able to approve or trigger tools; when fed to agents it
  is delimited and redacted like other untrusted input.
- AI identity tokens: 32 random bytes, only SHA-256 stored, scoped, revocable, per-project; rate limits per identity.
- Leases cannot block the owner indefinitely: max duration, admins can break leases (audited).
- Messages are length-limited, stored as plain text, rendered escaped (Markdown subset without HTML).

## Delivery

| Stage | Content | Owner |
|---|---|---|
| 1 | Schema + migration, leases, board transitions, scheduler/pipeline lease checks, room messages API + SSE, `@orchestrator` commands | backend agent |
| 2 | Board, Room and milestones UI | web agent |
| 3 | MCP server + AI identities (API + settings UI), objections into council, roadmap planning agent + Roadmap UI | backend + web agents |
| 4 (optional) | GitHub Issues/Projects sync | later |

## Tests

- Core: lease overlap and expiry, board transitions, scheduler skipping foreign assignments, pipeline waiting on leases,
  roadmap verify checks, command parsing.
- Server: RBAC/ACL on room, board, leases and identities; MCP tool authorization and rate limits; SSE delivery.
- Web: board move flows and room rendering (component tests), keyboard drag alternative.
