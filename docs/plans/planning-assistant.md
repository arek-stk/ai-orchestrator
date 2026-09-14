# Plan: Planning Assistant — Planning Studio, Refine, Explain, Ask

Request (2026-09-14): "ein KI-Assistent in der Webanwendung wär auch nicht schlecht, wo du dann in der Abteilung
Projektplanung oder -erstellung (oder erfinde etwas, was dazu passen könnte) mit dir den Plan oder die Idee nochmal
präzisiert".
Status: **proposal** (ADR-033 draft in §13). Nothing here is implemented. Builds on PR #12
(`feat/product-improvement`: health scans, improvement proposals, research agent, agent output cache — ADR-013…016)
and on ADR-030 (Project Room). Takes `docs/plans/plugin-scout.md` (ADR-031 draft) and
`docs/research/multi-account-ai.md` (provider accounts) into account.

## Zusammenfassung (Deutsch)

* **Name und Umfang:** Kern ist das **Planungsstudio** (Planning Studio). Dort wird eine grobe Idee im Gespräch mit der
  KI zu einem präzisen Plan und danach zu echten Projekten, Meilensteinen und Aufgaben. Dieselbe Engine liefert
  **Verfeinern** an Aufgaben und Meilensteinen, **Erklären** an Runs, Entscheidungen, Kosten und Freigaben sowie
  **Frag das Projekt**. Alles nutzt ein einziges Gesprächsmodell.
* **Ablauf:** Idee → höchstens 3 Rückfrage-Runden mit je bis zu 3 Fragen. Es gibt Schnellantworten, und „Jetzt
  entwerfen“ geht jederzeit. Ergebnis ist ein zod-validiertes **Brief** mit Ziel, Nutzern, Scope rein/raus,
  Akzeptanzkriterien, Risiken, Annahmen, offenen Fragen, Meilensteinen, Aufgaben (mit Schätzung und Abhängigkeiten)
  sowie Vorschlägen für Autonomie und Budget. Rechts daneben steht eine Live-Vorschau, die direkt editierbar ist.
  Jede Änderung wird eine unveränderliche Version mit Diff.
* **Anwenden nur mit Bestätigung:** Der Server berechnet den Anwendungsplan deterministisch und zeigt ihn als Diff.
  Erst nach ausdrücklicher Bestätigung wird er ausgeführt. Dabei gelten dieselben zod-Schemas, RBAC-/ACL-Prüfungen
  und Audit-Einträge wie bei den bestehenden Routen. Alles läuft in einer Transaktion und ist idempotent. Heikle
  Punkte laufen über Freigabe-Gates: Autonomie ≥ 3, Budget über der Schwelle oder das Ablösen einer Entscheidung.
* **Wichtiger Befund:** Der Scheduler plant heute `BACKLOG`- **und** `READY`-Aufgaben ein, und Aufgaben aus der API
  entstehen als `READY`. Vom Assistenten erzeugte Aufgaben bekommen deshalb standardmäßig einen **Hold** (nicht
  einplanbar). Sonst würde der Orchestrator sofort loslegen und Budget verbrauchen.
* **Konsistenz:** Das Brief wird gegen ADRs, Entscheidungen, Memories und STATE geprüft. Jeder Konflikt muss seine
  Quelle zitieren, wird sichtbar markiert und muss ausdrücklich aufgelöst werden: Brief ändern, ablösende
  Entscheidung vorschlagen oder begründet verwerfen. Nie wird still widersprochen.
* **Sicherheit:** Inhalte aus dem Repository, von Nutzern und von externen KIs gelten als nicht vertrauenswürdig. Der
  Assistent hat nur Lese-Tools über den Tool-Router und keine eigenen Seiteneffekte. Budgets gelten pro Nutzer,
  Sitzung und Projekt, das Modell-Tier wählt der Router, Rate-Limits greifen, Streaming läuft per SSE. Bezahlt wird
  zuerst über den Instanz-Account, später über Provider-Accounts: der Router wählt erst das Modell, dann den Account.
  Abo-Logins gibt es nie.
* **Ein Chat-System statt zwei:** `conversations` und `conversation_messages` ersetzen das geplante `room_messages`
  aus ADR-030. Der Room ist eine Konversation vom Typ `room`, Planungssitzungen sind eigene Threads und werden im Room
  verlinkt. Externe KIs (MCP) dürfen mitlesen, kommentieren und Änderungen *vorschlagen*. Sie lösen nie einen
  Assistenten-Aufruf oder ein Anwenden aus.
* **Erster Schnitt (Empfehlung):** das Planungsstudio für ein **bestehendes Projekt** („Vorhaben planen“). Es erzeugt
  Aufgaben mit Abhängigkeiten im Backlog, mit Hold. Die Gründe: Grounding-Daten sind vorhanden, Operator-Rechte
  reichen, es gibt keine Abhängigkeit von noch nicht gebauten ADR-030-Tabellen, und mit dem Mock-Provider ist alles
  testbar. Danach folgen „Neues Projekt aus Idee“, dann Erklären und Verfeinern, dann Room/MCP und Token-Streaming.
* **ADR-Nummer:** ADR-033 als Vorschlag. ADR-031 ist der Plugin Scout. ADR-032 bleibt für Provider-Accounts
  reserviert, weil deren Research ebenfalls „z. B. ADR-031“ nennt.
* **Offene Punkte und Trade-offs:** Token-Streaming braucht eine Erweiterung des Provider-Ports. Interaktive Turns
  laufen bewusst nicht über die Job-Queue (begründete Abweichung von ADR-004). Schätzungen bleiben grob. Offen sind
  auch private Entwürfe ohne Projekt und die Übergabe an Admins, weil nur Admins Projekte anlegen dürfen.

---

<!-- DETAILS-BELOW -->

## 1. Findings in the codebase that shape this design

| # | Finding | Evidence | Consequence for the assistant |
|---|---|---|---|
| F1 | Tasks created through the API start as `READY`; the scheduler treats `BACKLOG` **and** `READY` as schedulable, and `schedule()` has no autonomy or "held" gate (tool autonomy levels only limit side effects later, model spend still starts) | `packages/db/src/repositories.ts:181`, `packages/core/src/scheduler/scheduler.ts:92` | Applied plans must not start work by accident: new `tasks.scheduling_hold` (default on for assistant-created tasks), checked by the scheduler. ADR-030's board rule "Backlog ↔ Ready (humans)" needs the same mechanism. |
| F2 | `POST /api/projects` is admin-only; task creation is operator; approvals are admin-only (production deploy: owner) | `apps/server/src/routes.ts:206`, `:304`, `:493` | "New project from idea" needs an operator → admin hand-off; the apply preview must show the required role per operation. |
| F3 | The `ModelProvider` port only has `generateStructured` (no streaming) | `packages/core/src/models/provider.ts` | Stage 1 streams *phases* (grounding → drafting → validating), not tokens. Token streaming needs an optional port method (stage 5). |
| F4 | Every event is persisted in `events` and fanned out over SSE; NOTIFY payloads carry ids only | `routes.ts:637`, ADR-008/024 | Token deltas must **not** go through the event bus. Turn output streams on the turn's own HTTP response; the bus only carries content-free lifecycle events. |
| F5 | `AgentScope.projectId` is a required string; budget scopes are `global \| project \| task \| agent`; `usage_ledger.project_id` is nullable | `packages/core/src/agents/runtime.ts:11`, `budget/budget-guard.ts:1`, `packages/db/src/schema.ts:361` | Sessions without a project (idea for a new project) need a nullable project scope plus new `user` and `conversation` budget scopes. |
| F6 | The PLAN stage already decomposes complex tasks into a DAG via `PlanOutputSchema` and `parallelLayers`; `findCycle`/`topologicalOrder` exist | `orchestrator/stages.ts:276-314`, `dag/dag.ts` | Reuse the task-item shape and DAG checks; the brief's task list must be convertible with `TaskInputSchema` without loss. |
| F7 | ADR-030 plans `room_messages`, `milestones`, a `roadmap_output` planning schema and "roadmap proposal (generate, accept)" — none built yet | `docs/plans/project-room.md` | Unify now (cheap because nothing exists): one conversation model, and the brief's milestone/task section **is** the roadmap proposal. |
| F8 | PR #12: `routes-health.ts` pattern (ADR-016), research only on explicit request, agent cache with a hard deny-list, file summaries filled lazily, proposals with sticky fingerprints, **no web UI yet** | `git diff origin/main...origin/feat/product-improvement` | Assistant gets its own route module; research is a button, not automatic; assistant turns are non-cacheable, Explain is cacheable; conflict resolutions reuse the sticky-fingerprint idea. |
| F9 | Council already delimits model text as untrusted; secret redaction exists in context builder | `agents/council.ts:119`, `security/secrets.ts` | Reuse the same delimiting and redaction for all grounding sources and participant messages. |
| F10 | ADR numbers: main ends at ADR-030; PR #12 uses 013–016; plugin scout drafts ADR-031; the multi-account research suggests "e.g. ADR-031" | `docs/DECISIONS.md`, `docs/plans/plugin-scout.md:5`, `docs/research/multi-account-ai.md:326` | This plan proposes **ADR-033** and recommends ADR-032 for provider accounts to resolve that collision. |

## 2. Name and scope

One engine (`packages/core/src/assistant`) with four surfaces. Names in the UI: **Planning Studio**, **Refine**,
**Explain**, **Ask about this project**. Internally one agent role `assistant` with read-only tools.

| Surface | Where | What it does | Output | Side effects |
|---|---|---|---|---|
| **Planning Studio** | `/planning`, project tab "Planning", "Plan with AI" next to "New task" | Idea → clarifying questions → versioned brief → apply | Brief (§3.3) + apply plan | Only via confirmed apply |
| **Refine** | Task row/detail (status `BACKLOG`, `READY`, `BLOCKED` — the statuses `PATCH /api/tasks/:id` accepts), milestone (after ADR-030 stage 1), improvement proposal "Plan this" (PR #12, once it has UI) | Sharpen one item: goal, acceptance criteria, split into sub-tasks, estimate, risks | Brief of kind `refine_task` / `refine_milestone` | Confirmed apply → task patch and/or new child tasks |
| **Explain** | Run page (blocked/failed), decision card, approval card ("What happens if I approve?"), costs page, blocked task | One-shot grounded explanation with citations; "Continue in chat" opens a thread | Answer with references | None |
| **Ask about this project** | Project header / overview | Q&A grounded on repo index, STATE/ADRs in the repo, decisions, memories, latest health scan, proposals | Answer with references; "Turn into plan" opens a Planning Studio session seeded with the answer | None |

**Build first: Planning Studio for an existing project** ("Plan an initiative/feature in project X").

* It is exactly the user's request (planning), and it has **full grounding**: repository index with file summaries,
  decisions, memories, health scan and proposals (PR #12). A brief for a brand-new idea has almost nothing to be
  checked against, so the consistency check — the most distinctive safety feature — would be hollow.
* Apply maps to existing concepts only: tasks with dependencies (`TaskInputSchema`), operator role, per-project ACL.
  No dependency on unbuilt ADR-030 tables (milestones stay in the brief and in memory until they exist).
* It forces the hard parts early (bounded turns, versioning, apply diff, hold, audit) with a small UI surface.
* "New project from idea" follows immediately (stage 3) because it reuses the same studio; it adds private drafts,
  admin hand-off and project creation.
* Explain is cheaper but does not answer the request; it comes in stage 4 as a quick win on the same engine.

## 3. Conversation flow: idea → brief → apply

### 3.1 Session state machine

```
created ─► intake ─► clarifying (≤ maxClarifyRounds) ─► drafting ─► refining ⇄ (chat turns | direct edits)
                         │ "Draft now"                     ▲                │
                         └─────────────────────────────────┘                ▼
                                                    ready check ─► apply preview ─► confirm
                                                                                     │
                                         pending_approval ◄── gated ────────────────┤
                                                 │ approved                          │ not gated
                                                 ▼                                   ▼
                                               applied ◄──────────────────────────── applied
   any state ─► archived (manual) | abandoned (no activity for SESSION_IDLE_DAYS, default 30)
```

### 3.2 Bounds (all enforced server-side, none only in the prompt)

| Bound | Default | Enforcement |
|---|---|---|
| Clarifying rounds per session | 3 (project setting 1–5) | The turn schema is chosen per turn: when `roundsLeft = 0`, `questions` is `z.array(...).max(0)` — the model cannot ask more (no coercion, ADR-010) |
| Questions per round | 3, each with ≤ 4 quick-reply options | Schema |
| Turns per session | 40 | Policy check before routing; then "Session limit reached — edit the brief directly or start a new session" |
| Model calls per turn | ≤ 3 (1 main call, ≤ 1 context-request hop, ≤ 1 retry on invalid output) | `AssistantService` loop counter |
| Context-request hops | 1 hop, ≤ 3 read-tool calls | Schema + service |
| Running turns | 1 per session, 3 per user | 409 `turn_in_progress` |
| Turn wall time | 120 s | Abort signal → turn `failed` (`timeout`) |
| Session budget | $1.00 (project setting), user daily $3.00 (global setting) | New budget scopes `conversation`, `user` (§4.4) |
| Input size | message ≤ 8 000 chars; brief ≤ 40 tasks, ≤ 8 milestones | Zod |

"Draft now" skips remaining rounds; unanswered questions become `openQuestions` or `assumptions`.

### 3.3 Brief schema (zod, `packages/core/src/assistant/brief.ts`)

Required-and-nullable fields (convention from `agents/schemas.ts`). Items are addressed by stable `key`s, never by
array index, so patches, diffs and human edits stay stable when lists are reordered.

```ts
PlanningBriefSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(['new_project', 'initiative', 'refine_task', 'refine_milestone']),
  language: z.string().max(10),                  // e.g. "de"; brief follows the session language
  title: Text(200), problem: Text(4000), goal: Text(2000),
  targetUsers: z.array(z.object({ key: Key, name: Text(120), needs: List(10, 300) })).max(10),
  scope: z.object({ in: KeyedList(30), out: KeyedList(30) }),
  acceptanceCriteria: z.array(z.object({ key: Key, text: Text(500), measurable: z.boolean() })).max(30),
  risks: z.array(z.object({ key: Key, description: Text(1000), likelihood: LMH, impact: LMH,
                            mitigation: Text(1000), gatedAction: z.enum(GATED_ACTIONS).nullable() })).max(20),
  assumptions: z.array(z.object({ key: Key, text: Text(500), confidence: Confidence })).max(20),
  openQuestions: z.array(z.object({ key: Key, text: Text(500), blocking: z.boolean(), answer: Text(1000).nullable() })).max(20),
  milestones: z.array(z.object({ key: Key, title: Text(200), goal: Text(1000), exitCriteria: List(10, 300) })).max(8),
  tasks: z.array(z.object({
    key: Key, title: Text(200), goal: Text(2000), kind: z.enum(TASK_KINDS),
    milestoneKey: Key.nullable(), dependsOn: z.array(Key).max(20),
    acceptanceCriteria: List(15, 500), risk: z.enum(RISKS),
    estimate: z.object({ points: z.union([1, 2, 3, 5, 8, 13].map(z.literal)), complexity: z.enum(COMPLEXITIES), confidence: Confidence }),
    suggestedRole: z.enum(PLAN_TASK_ROLES),
    existingTaskId: z.string().nullable(),       // refine: patch instead of create
  })).max(40),
  execution: z.object({
    autonomyLevel: z.object({ suggested: z.number().int().min(0).max(4), rationale: Text(1000) }),
    budget: z.object({ suggestedUsd: z.number().min(0).max(100_000), perTaskMaxCostUsd: z.number().min(0).max(10_000), basis: Text(1000) }),
    repository: RepoRefSchema.nullable(),       // new_project only
  }),
  references: z.array(z.object({ type: z.enum(['adr', 'decision', 'memory', 'health_scan', 'proposal', 'file', 'research']),
                                 ref: Text(300), why: Text(300) })).max(30),
  confidence: Confidence,
});
```

`verifyBrief(brief, ctx)` (deterministic; failures block apply, not saving):

* keys unique per list; every `dependsOn` and `milestoneKey` resolves; no cycle (`findCycle`);
* every task converts with `TaskInputSchema.parse` (title ≥ 3 chars, criteria ≤ 30, …);
* no blocking open question without an answer;
* every `references[]` entry exists in the turn's context manifest (uncited references are dropped with an issue);
* `execution.autonomyLevel.suggested ≥ 3` requires a repository with CI (project profile) — otherwise an issue;
* `execution.budget.suggestedUsd ≥ Σ perTaskMaxCostUsd` over tasks; project budget headroom is shown, not enforced;
* secret patterns (`findSecrets`) and sensitive paths anywhere in the brief → issue (never stored in tasks);
* risk terms (deploy, migration, delete data, secrets, permissions, external service) without a `gatedAction` → warning.

### 3.4 Turn schema and patch semantics

```ts
AssistantTurnSchema(roundsLeft) = z.object({
  reply: Text(4000),                                         // Markdown subset, rendered escaped
  mode: z.enum(['clarify', 'propose', 'refine', 'ready']),
  questions: z.array(z.object({ key: Key, text: Text(500), why: Text(300),
                                options: List(4, 120), blocking: z.boolean() })).max(roundsLeft > 0 ? 3 : 0),
  briefPatch: z.array(z.object({ op: z.enum(['set', 'add', 'remove']),
                                 path: BriefPath, value: z.unknown() })).max(40),
  contextRequests: z.array(z.object({ tool: z.enum(ASSISTANT_READ_TOOLS), args: z.unknown() })).max(3),
  conflicts: z.array(ConflictSchema).max(10),
  confidence: Confidence,
});
```

* `BriefPath` is an allow-listed pointer grammar: `/goal`, `/scope/in`, `/tasks/{key}`, `/tasks/{key}/estimate`, … —
  never arbitrary JSON pointers. Patch values are validated by applying the patch and re-parsing the whole brief.
* **Human edits win.** Fields a human edited since the assistant last saw them are *locked* for the assistant. Patch
  operations on locked paths are not applied; they become **suggestions** shown inline ("Suggested: … Accept / Keep
  mine"). Accepting a suggestion is a human edit (new version).
* Trade-off: LLM-generated patches can be wrong or partial. Mitigations: re-parse after patching; if the patched brief
  fails zod, the turn is retried once asking for section-level `set` operations; a second failure fails the turn
  without changing the draft ("nothing was changed").

### 3.5 Versioned drafts

* `brief_drafts` rows are immutable; `version` increments per session (unique). Authors: `assistant`, `human`,
  `suggestion_accepted` (from an external AI suggestion accepted by a human).
* Human edits are buffered client-side and committed as a new version when the user sends a chat message, clicks
  **Save**, or after 5 s idle. Saves carry `baseVersion`; a stale base answers 409 with the newer version and a diff
  ("Brief changed by Carol (v8). Review / Save mine as v9").
* Diff between any two versions is computed in core by key (added/removed/changed per field), never by text.
* **Restore** creates a new version from an old one; nothing is deleted.

### 3.6 Consistency check against ADRs and decision memory

Runs automatically when the assistant first reaches `mode: 'propose'`, on demand ("Check consistency"), and always as
part of the apply preview if the brief changed since the last check.

1. **Deterministic retrieval** (no model): decisions (`decisions` table: question key and keyword overlap with brief
   goal, scope, task titles and `touchesAreas`), memories (project scope), ADR documents found in the repository
   index (`docs/DECISIONS.md`, `docs/adr/**`, `adr/**`, `ARCHITECTURE.md`, parsed into `## ADR-nnn` sections), STATE
   documents (`docs/STATE.md`), latest health scan breakdown, open/dismissed proposals (dismissed proposals are
   decisions too).
2. **One reasoning-tier call** (`consistency_check` definition) gets the brief plus the retrieved sources as delimited
   untrusted data and returns conflicts: `{ sourceType, sourceRef, sourceQuote (≤ 300), briefPath, explanation,
   severity: 'contradiction' | 'tension' | 'duplicate' }`.
3. **Verify:** every conflict must cite a `sourceRef` present in the manifest and a `sourceQuote` that occurs in that
   source (normalised substring match). Uncited or unverifiable conflicts are dropped and counted.
4. **Deterministic duplicates:** tasks whose normalised title matches an open task or an accepted/dismissed proposal
   fingerprint (PR #12 fingerprint function) are flagged `duplicate` without a model.
5. Conflicts get a fingerprint `(sourceRef, briefPath, severity)` so resolutions stay sticky across versions.

**Resolution is explicit and audited — never silent:**

| Resolution | Effect |
|---|---|
| Change the brief | Conflict re-evaluated on the next version; closes when it no longer reproduces |
| Propose superseding decision | Apply plan gains an item "Record decision request: supersede ADR-xxx / decision yyy" → becomes a task of kind `docs` ("Write ADR superseding …") **and** marks the apply as gated `architecture_change` |
| Not a conflict (with reason ≥ 20 chars) | Closed with note; stays closed for this fingerprint; audit `assistant.conflict.dismissed` |

Apply is disabled while any `contradiction` is open. `tension` and `duplicate` require an acknowledgement checkbox in
the apply dialog.

### 3.7 Apply

1. **Preview** (`POST …/apply-preview`, no model, no side effects): core `buildApplyPlan(brief, target, actor,
   projectState)` returns ordered operations:
   `create_project` (new project only) · `patch_project` (autonomy/budget suggestions, only if the user opts in) ·
   `create_milestone` (after ADR-030 stage 1; before that milestones are written as one project memory
   `kind = 'plan.milestones'` and task goals get a "Milestone: …" line) · `create_task` (topological order, dependencies
   mapped from keys to new ids) · `patch_task` (refine) · `record_memory` (assumptions and accepted risks) ·
   `record_decision` (plan rationale). Each operation carries `requiredRole`, `allowed` for the current user, and
   `gatedAction | null`. The preview also returns `planHash` = sha256 of the canonical plan.
2. **Dialog** shows the diff grouped by entity with counts, per-task exclude checkboxes (excluding a task that others
   depend on is rejected with a message), a scheduling choice **"Keep new tasks on hold (recommended)" / "Let the
   orchestrator start them"** (the latter requires operator and autonomy ≥ 2), required role badges, and the approval
   notice for gated operations.
3. **Confirm** (`POST …/apply` with `version`, `planHash`, `excludedKeys`, `holdTasks`, `idempotencyKey`):
   * re-builds the plan; a different hash answers 409 `plan_changed` (project state or brief changed meanwhile);
   * checks role and ACL for **every** operation with the same helpers as the existing routes (`acl.assertProject`,
     role checks, admin-only rules from `PATCH /api/projects/:id`), then executes all operations in **one DB
     transaction** through shared application services that the existing routes are refactored to use
     (`createProjectService`, `createTaskService`) — same zod schemas, same events (`project.created`,
     `task.created`), same audit actions (`project.create`, `task.create`) plus `assistant.plan.apply` with the
     application id;
   * gated plans (autonomy suggestion ≥ 3, budget change above the project's `high_cost` threshold, supersede
     proposals, a `create_project` requested by a non-admin) create an `approvals` row with
     `details.kind = 'assistant_apply'` and the stored plan; the application waits in `pending_approval`; on approval
     the same executor runs with the approver as actor of the gated operations and the requester as actor of the rest;
     on rejection nothing is created;
   * `record_decision` is written by the orchestrator service with `consulted = [{ role: 'assistant', … }]`,
     `decision = brief summary`, `evidence = references`, and the confirming human in `reason` — the assistant never
     writes decisions itself (spec: only the orchestrator writes decisions).
4. **Result:** created ids linked in the session; tasks get `origin = { type: 'assistant', conversationId, draftId,
   applicationId }` and `scheduling_hold = true` unless the user chose otherwise; session `applied`. With the Room
   (stage 6) a system message "Plan applied by Alice: 14 tasks in 3 milestones" is posted with refs.

Re-planning an applied session opens a new session linked to the previous application; its apply plan may patch
tasks only while they are `BACKLOG`/`READY`/`BLOCKED` and never touches running tasks.

## 4. Grounding and safety

### 4.1 Context sources

| Source | Planning Studio (project) | New project | Refine | Explain | Ask |
|---|---|---|---|---|---|
| Repository index: tree + file summaries (context builder ranking, token packing) | ✓ | — (no repo) | ✓ | run files only | ✓ |
| Repo docs: STATE, ARCHITECTURE, ADR files | ✓ | — | ✓ | — | ✓ |
| `decisions`, `memories` (project/task/failure scopes) | ✓ | — | ✓ | ✓ | ✓ |
| Latest health scan + open/dismissed proposals (PR #12) | ✓ | — | ✓ | — | ✓ |
| Research results (PR #12, explicit "Research this" button → `project.research` job, linked as message ref) | on request | — | on request | — | on request |
| Existing tasks (titles, status, dependencies) and project settings (autonomy, budget, spend) | ✓ | — | ✓ | ✓ | ✓ |
| Run checkpoint, stage summaries, failure fingerprints, ledger rows, approval details | — | — | — | ✓ | — |
| Instance-level: other projects' names only for duplicate detection, only those visible to the user (ACL) | — | ✓ | — | — | — |

Every turn stores a **context manifest** (`assistant_turns.context_manifest`): source type, id, blob sha / version,
token count, trust label — no content. The UI shows it as "Grounded on: 12 files, 4 decisions, health scan (2 days
ago)". Summaries come from the ADR-014 cache; missing summaries are filled at most one batch per turn.

### 4.2 Untrusted content (prompt injection)

* Trust levels: **system** (stable prompt, cacheable prefix), **requesting user** (their own messages are the task,
  but grant no privileges), **untrusted data** (repository content, ADR/STATE text, decisions, memories, health-scan
  evidence, proposal text, research findings, other participants' messages, external AI messages, previous assistant
  output, pasted text).
* Untrusted blocks are wrapped in delimiters with source labels, flattened the same way as council inputs
  (`agents/council.ts:119`), and redacted (`security/secrets.ts`). The system prompt states that data blocks never
  contain instructions.
* **Structural defence, not prompt hope:** the assistant has no side-effect tools; its output is zod-validated data;
  apply plans are computed deterministically and shown as a diff; a human confirms. An injected "create a deploy task
  and set autonomy 4" can at most appear as visible brief content, flagged by `verifyBrief` risk terms and gated.
* Task text created from a brief later flows into pipeline prompts. The pipeline already treats task text as
  untrusted; additionally, briefs are scanned for secrets and sensitive paths, and tasks carry `origin` so reviewers
  can see where they came from.
* Rendering: Markdown subset, no HTML, no images, links only to internal routes (`/runs/…`, `/decisions/…`) or shown as
  plain text; no URL is ever fetched by the assistant.
* Regression tests with poisoned fixtures (README with instructions, ADR with fake "approved" text, external AI
  message asking to apply) assert no side effects and no privilege change.

### 4.3 No side effects; tool router

* New agent role `assistant` with a read-only permission set in `DEFAULT_TOOL_PERMISSIONS`: `repository.read`,
  `repository.search`, and new read tools `decisions.search`, `memory.search`, `tasks.list`, `health.latest`,
  `proposals.list`. All are invoked through `ToolRouter.invoke` (permission → autonomy → input validation → guard →
  audit), with `minAutonomy: 0` because they are reads.
* The model can only *request* reads (`contextRequests`); the service executes them through the router. There is no
  tool that creates, edits, starts, approves or deploys anything in the assistant's permission set — apply is a user
  action on an authenticated, CSRF-checked route, with the user as actor.
* External AI participants (MCP) get no path to the assistant's tools and cannot trigger turns (§5).

### 4.4 Budgets, model tiers, streaming, rate limits

* **Budget scopes:** `global` (daily) → `project` (if any) → `conversation` (session cap) → `user` (daily assistant
  spend per user). `BudgetScopeKind` gains `conversation` and `user`; `AgentScope.projectId` becomes nullable; ledger
  rows get `conversation_id` and `requested_by_user_id`. `degrade` → cheaper tier; `pause` → the turn ends with
  "Budget reached" and the brief stays fully editable by hand.
* **Tier choice** (through `ModelRouter`, role `assistant`, project/global role overrides apply):
  intake/clarify/refine turns → `balanced`; "Draft now"/first full brief and consistency check → `reasoning`;
  Explain and short Ask → `fast`, escalating to `balanced` when the question references more than one run or
  decision. Prior invalid output escalates one tier (existing router behaviour).
* **Caching (ADR-014):** `planning_assistant`, `consistency_check` and `ask` are added to `NON_CACHEABLE_AGENT_KEYS`.
  `explain` opts in (`cacheTtlMs` 24 h): its key already includes the rendered prompt, i.e. the record version.
* **Streaming:** the turn endpoint answers `text/event-stream` on the POST itself (read with `fetch` + stream reader;
  `EventSource` cannot POST). Events: `accepted`, `phase` (`grounding | drafting | reading_context | validating |
  saving`), `delta` (stage 5 only), `message`, `draft`, `conflicts`, `error`, `done`. Because the stream rides the same
  connection that started the turn, multi-instance deployments need no cross-instance relay. If the client
  disconnects, the turn still finishes (spend is already committed) and the result is persisted; other viewers refresh
  on the content-free bus event `assistant.turn.completed`.
* **Token streaming (stage 5):** optional `ModelProvider.streamStructured?(request, onReplyDelta)`; adapters that
  support streamed structured output emit deltas of the `reply` field only; others fall back to phases. The final
  object is still validated before anything is saved; streamed text is marked provisional until `done`.
* **Rate limits:** `@fastify/rate-limit` per user on turn/explain routes (20/min), a daily turn cap per user (300),
  1 running turn per session, 3 per user, apply routes 10/min.

### 4.5 Which provider account pays

* **Before provider accounts exist:** the instance's configured providers pay; per-user and per-session budgets are
  internal accounting. The composer shows "Billed to: instance".
* **With provider accounts (ADR-032 proposal from the multi-account research):** the router selects the model first,
  then the account. For assistant turns the order is: run/session pin → **requesting user's own grant** for this
  project (interactive work is personal) → project sponsor grant → instance account. The composer shows the account
  name and vendor ("Billed to: Alice's Anthropic key"), because it also tells the user **where the conversation
  content is processed**. No failover to another person's account on 429; subscription/OAuth logins are never an
  option (research rows 8–10).
* **Bring your own AI:** a colleague who wants to use their own Claude/ChatGPT subscription joins through MCP (§5);
  their compute never appears in our ledger.

### 4.6 Privacy and visibility

* Sessions with a project are visible according to ADR-022: viewers and above who can see the project can **read**
  them; starting sessions, sending turns and editing drafts need operator on the project (turns cost money); apply needs
  the roles in §3.7.
* `visibility = 'private'` is the default for sessions **without** a project (ideas for new projects): only the creator
  can read them; owners/admins see metadata (title hidden, cost, counts) in cost views, not content. The creator can
  **share with admins** for hand-off, which switches visibility to `admins` and is audited. Open question §11.4.
* Project-scoped sessions can be marked private by their creator until first apply (draft thinking), with the same
  admin metadata rule; applying makes the session project-visible because created tasks link to it.
* Content-free bus events: private sessions emit events with `projectId = null` and no title (ADR-022 hides project-less
  events from restricted users).
* Retention: archived sessions keep drafts and messages; a project deletion cascades; users can delete their private
  sessions (hard delete, audited). Retention policy and data export are open questions (§11.9).

## 5. Relation to the Project Room (ADR-030): one conversation model

**Recommendation:** implement ADR-030's `room_messages` as a generic `conversation_messages` table from the start.
Every chat surface is a `conversation`:

| `conversations.kind` | Scope | Created by | Assistant participates |
|---|---|---|---|
| `room` | exactly one per project | project creation / migration | only when addressed (`@assistant …`) by a human; `@orchestrator …` commands stay with the command parser (ADR-030) |
| `planning` | project or private | Planning Studio | on every human message in the thread (it is the point of the thread) |
| `refine` | project | Refine on task/milestone/proposal | on every human message |
| `explain`, `ask` | project | Explain/Ask | first answer automatically, follow-ups on human messages |

* **Is the assistant a participant?** Yes, as `author_type = 'assistant'` (display "Planning assistant"). It is not
  the orchestrator: it proposes; the orchestrator (through human-confirmed apply) decides and records decisions.
* **Threads, not room noise:** planning sessions are separate conversations. Starting one in a project posts one
  `room` message with intent `status` and a ref `{ conversationId }` ("Alice started planning 'Offline mode'"), and
  apply posts the result. `@orchestrator plan <goal>` from ADR-030 opens a planning session instead of generating a
  roadmap in the room. ADR-030's "roadmap proposal (generate, accept)" routes become the Planning Studio's apply; the
  `roadmap_output` schema is the brief's `milestones` + `tasks` section — no second planning schema.
* **External AIs via MCP (ADR-030 stage 3):** yes, they can join a planning session if their identity has the scope
  `planning:participate` and project membership. MCP tools: `list_planning_sessions`, `get_brief(version?)`,
  `post_session_message`, `suggest_brief_change` (a patch stored as a suggestion, shown to humans with
  Accept/Reject). They **cannot** trigger an assistant turn, edit the brief directly, resolve conflicts or apply.
  Their messages are untrusted data in the assistant's context and carry an "External AI" badge. This keeps AI-to-AI
  interaction bounded: an external AI message never causes a model call on our side.
* **Humans in the same session:** several humans may post; the assistant answers each human message in order (one
  running turn per session; later messages queue client-side with a notice). Direct edits by anyone create versions;
  locks (§3.4) are per field, not per user.

## 6. Data model

Migration after the current schema owner's latest (PR #12 adds `0001`; plugin scout and ADR-030 may add more — take
the next free number at implementation time). If ADR-030 stage 1 lands first, it creates `conversations` and
`conversation_messages` in this shape and this plan only adds the assistant tables.

| Table / change | Columns |
|---|---|
| `conversations` | `id`, `project_id` (nullable, cascade), `kind` (`room \| planning \| refine \| explain \| ask`), `title` (≤ 200), `status` (`active \| pending_approval \| applied \| archived \| abandoned`), `visibility` (`project \| private \| admins`), `subject_type` (`task \| milestone \| run \| decision \| approval \| proposal \| cost_period \| null`), `subject_id`, `created_by`, `budget_usd`, `spent_usd`, `turn_count`, `clarify_rounds_used`, `max_clarify_rounds`, `active_draft_version`, `language`, `last_activity_at`, `created_at`, `updated_at`, `archived_at`. Unique partial index: one `room` per project. Index `(project_id, kind, last_activity_at)`, `(created_by, last_activity_at)` |
| `conversation_messages` (replaces ADR-030 `room_messages`) | `id`, `conversation_id` (cascade), `project_id` (denormalised for ACL/event filters), `author_type` (`human \| assistant \| orchestrator \| agent \| external_ai \| system`), `author_id`, `intent` (ADR-030 intents + `answer \| clarifying_question \| brief_update \| suggestion`), `body` (≤ 8 000, plain text/Markdown subset), `data` jsonb (e.g. questions with options, answered option keys), `refs` jsonb `{taskId?, runId?, decisionId?, approvalId?, conversationId?, draftVersion?, paths?[]}`, `reply_to`, `turn_id`, `created_at`, `deleted_at` (soft delete for moderation, body cleared). Index `(conversation_id, id)` for cursor paging |
| `assistant_turns` | `id`, `conversation_id`, `trigger_message_id`, `client_turn_id` (unique per conversation, idempotent resend), `requested_by`, `status` (`running \| completed \| failed \| cancelled \| budget_paused`), `failure_kind`, `phase`, `agent_run_ids` jsonb (links to existing `agent_runs`), `model_id`, `provider_account_id` (nullable; ADR-032), `cost_usd`, `tokens`, `context_manifest` jsonb, `context_requests` jsonb, `resulting_draft_version`, `lease_until`, `started_at`, `completed_at`, `error` |
| `brief_drafts` | `id`, `conversation_id`, `version` (unique with conversation), `base_version`, `author_type` (`assistant \| human \| suggestion_accepted`), `author_id`, `turn_id`, `schema_version`, `brief` jsonb, `patch` jsonb (ops from base), `locked_paths` jsonb, `verify_issues` jsonb, `summary` (≤ 300), `created_at` |
| `brief_suggestions` | `id`, `conversation_id`, `draft_version`, `source` (`assistant \| external_ai`), `author_id`, `patch` jsonb, `status` (`open \| accepted \| rejected \| stale`), `decided_by`, `decided_at` |
| `brief_conflicts` | `id`, `conversation_id`, `draft_version`, `fingerprint` (unique with conversation), `source_type`, `source_ref`, `source_quote`, `brief_path`, `severity`, `explanation`, `status` (`open \| resolved_by_change \| supersede_proposed \| dismissed`), `note`, `resolved_by`, `resolved_at`, `created_at` |
| `brief_applications` | `id`, `conversation_id`, `draft_version`, `idempotency_key` (unique), `plan_hash`, `plan` jsonb (operations), `excluded_keys` jsonb, `hold_tasks` boolean, `requested_by`, `approval_id` (nullable), `status` (`pending_approval \| applied \| rejected \| failed`), `result` jsonb (created/patched ids), `error`, `created_at`, `applied_at` |
| `tasks` (new columns) | `scheduling_hold` boolean default false, `hold_reason` text, `origin` jsonb (`{type:'assistant', conversationId, draftVersion, applicationId}` \| `{type:'proposal', …}` \| null). ADR-030 columns (`milestone_id`, `estimate_points`, `labels`, …) come from ADR-030 stage 1 |
| `usage_ledger` (new columns) | `conversation_id`, `requested_by_user_id` (ADR-032 adds `provider_account_id`, `billed_owner_user_id`) |
| Settings | Project `settings.assistant`: `{ enabled, maxClarifyRounds, sessionBudgetUsd, allowExternalAiParticipants, defaultHoldTasks }`. Global settings: `assistantUserDailyBudgetUsd`, `assistantDailyTurnsPerUser`, `assistantViewerExplain` (bool) |

## 7. Core (IO-free) — `packages/core/src/assistant/`

| Module | Responsibility |
|---|---|
| `brief.ts` | `PlanningBriefSchema`, `verifyBrief`, `diffBriefs(a, b)` by key, `applyBriefPatch(brief, ops, lockedPaths) → { brief, suggestions, rejected }`, `briefToTaskInputs` (points → complexity/maxCost/tokenBudget mapping with project defaults) |
| `turn-policy.ts` | Pure policy: `planTurn(session, project, user) → { allowed, reason, mode hint, tier, schema (roundsLeft), limits }`; who may do what (role × session visibility × kind) |
| `definitions.ts` additions | `planning_assistant`, `consistency_check`, `explain`, `ask` agent definitions (system prompts, schemas, verify checks; only `explain` has `cacheTtlMs`) |
| `grounding.ts` | `buildAssistantContext(request, ports)` → labelled, delimited, redacted sections + `ContextManifest`; reuses `rankFiles` and packing from the context builder; executes `contextRequests` through the `ToolRouter` |
| `consistency.ts` | ADR section parser, deterministic retrieval and duplicate detection, conflict verify (citation + quote check), fingerprints |
| `apply-plan.ts` | `buildApplyPlan` (ordering via `topologicalOrder`, role requirements, gated actions via `requiresApproval`, `planHash`), `validateExclusions` |
| `service.ts` | `AssistantService.runTurn(input, onEvent)`: policy → persist human message → grounding → `AgentRuntime.run` (budget scopes) → optional context hop → verify → patch → persist message/draft/conflicts → content-free events. Bounded loop, abort signal, lease heartbeat |
| `ports.ts` | `ConversationRepository`, `MessageRepository`, `TurnRepository`, `DraftRepository`, `SuggestionRepository`, `ConflictRepository`, `ApplicationRepository`, `PlanExecutor` (transactional executor implemented in `packages/db`) |
| Changes elsewhere | `AgentRole` + `assistant`; `DEFAULT_TOOL_PERMISSIONS.assistant`; new read tools; `BudgetScopeKind` + `conversation`, `user`; `AgentScope.projectId: string \| null`; scheduler skips `schedulingHold`; events `assistant.*` in `EventPayloads`; `ModelProvider.streamStructured?` (stage 5); in-memory stores in `testing/` |

Events (content-free payloads): `assistant.session.created {conversationId, kind}`, `assistant.turn.completed
{conversationId, turnId, status, costUsd}`, `assistant.draft.saved {conversationId, version, authorType}`,
`assistant.conflict.flagged {conversationId, count}`, `assistant.plan.approval_required {conversationId,
applicationId, approvalId}`, `assistant.plan.applied {conversationId, applicationId, createdTasks, createdProjectId}`.

## 8. Server — `apps/server/src/routes-assistant.ts` (ADR-016 pattern) + `assistant.ts` composition

| Method | Path | Role (plus ACL) | Notes |
|---|---|---|---|
| POST | `/api/assistant/sessions` `{projectId \| null, kind, subject?, idea, visibility?}` | operator (project) · operator global for private new-project drafts | 201; posts the idea as first message; does **not** start a turn |
| GET | `/api/assistant/sessions?projectId&kind&status&mine&cursor` | viewer | private sessions only for creator; admins get metadata |
| GET | `/api/assistant/sessions/:id` | viewer | session, last 50 messages, active draft, open conflicts/suggestions, running turn |
| GET | `/api/assistant/sessions/:id/messages?before=` | viewer | cursor paging |
| PATCH | `/api/assistant/sessions/:id` `{title?, status: 'archived'?, visibility?}` | creator or project operator | visibility changes audited |
| POST | `/api/assistant/sessions/:id/turns` `{message, clientTurnId, draftNow?}` | operator | `Accept: text/event-stream` → SSE response; otherwise 202 + poll. 409 `turn_in_progress`, 402-style 409 `budget_paused`, 429 |
| POST | `/api/assistant/turns/:id/cancel` | requester or project operator | aborts provider call; partial spend recorded |
| GET | `/api/assistant/sessions/:id/drafts` · `/drafts/:version` · `/drafts/:version/diff?against=` | viewer | |
| POST | `/api/assistant/sessions/:id/drafts` `{baseVersion, brief}` | operator | 201 new version with `verifyIssues`; 409 stale base; 422 zod error |
| POST | `/api/assistant/suggestions/:id/accept` · `/reject` | operator | accept = new version |
| POST | `/api/assistant/sessions/:id/consistency-check` `{version}` | operator | model call, budgeted |
| POST | `/api/assistant/conflicts/:id/resolve` `{resolution, note}` | operator | audited |
| POST | `/api/assistant/sessions/:id/apply-preview` `{version, excludedKeys?, holdTasks?}` | viewer (read-only preview), shows `allowed` per op | no side effects |
| POST | `/api/assistant/sessions/:id/apply` `{version, planHash, excludedKeys, holdTasks, idempotencyKey}` | per operation (§3.7) | 201 applied · 202 pending approval · 409 `plan_changed` · 403 · repeated key returns the first result |
| POST | `/api/assistant/explain` `{subjectType, subjectId}` | operator (viewer if `assistantViewerExplain`) | SSE like turns; creates an `explain` conversation |
| POST | `/api/projects/:id/ask` `{question}` | operator | SSE; creates an `ask` conversation |
| POST | `/api/tasks/:id/hold` · `/release` | operator | clears/sets `scheduling_hold`, audited (also used by ADR-030 board) |

* **Execution model:** a turn runs in the API process that received the POST — not as a durable job. Justification:
  interactive, bounded (≤ 3 model calls, 120 s), idempotent via `client_turn_id`, cheap to retry; a crashed process
  leaves a `running` turn whose `lease_until` expires and the scheduler tick marks it `failed (interrupted)` so the user
  can retry. This is a deliberate, scoped exception to ADR-004's "one loop iteration = one durable job", recorded in
  ADR-033. Consistency checks and apply run inline too; research stays a job (PR #12).
* `SERVER_ROLE=api` instances therefore need provider credentials (already true: the container builds providers for
  every role). Metrics: `assistant_turns_total{status}`, `assistant_turn_duration_seconds`, `assistant_spend_usd`,
  `assistant_apply_total{status}`.
* Refactor: move the bodies of `POST /api/projects` and `POST /api/projects/:id/tasks` into
  `apps/server/src/services/{projects,tasks}.ts` (validation, events, audit) used by both routes and the plan
  executor — one small change in the `routes.ts` merge hotspot.
* Approval integration: `orchestrator.onApprovalDecided` gets a branch for `details.kind = 'assistant_apply'` (no run)
  that calls the plan executor; expiry (ADR-023) marks the application `rejected` with reason "expired".

## 9. Web UI

### 9.1 Entry points

* Main navigation: **Planning** (lucide `NotebookPen`) between Projects and Agents → `/planning`: "New project from
  idea" (stage 3), "My sessions", sessions in my projects.
* Projects page header: "New project from idea" (secondary button; shown to operators, apply hand-off to admins).
* Project page: new tab **Planning** (session list + "Plan with AI"); Tasks tab: "Plan with AI" next to "New task";
  Overview: "Ask about this project" input (stage 4).
* Task row/detail menu (BACKLOG/READY/BLOCKED): **Refine**; held tasks show a `Pause`-icon chip "On hold" with
  "Release" action.
* Run page (blocked/failed), decision card, approval card, costs page, blocked task: **Explain** (ghost button,
  `MessageCircleQuestion`).
* Improvement proposals (PR #12, once UI exists): **Plan this**.
* Project Room (stage 6): planning sessions as thread cards; `@assistant` autocomplete.

### 9.2 Studio layout (`/planning/[sessionId]`)

```
┌ PageHeader: [title (inline edit)] [StatusBadge] [v7 · you, 2m ▾] [$0.18 / $1.00] [Billed to: instance]   ┐
│                                        [Check consistency] [History] [Review & apply ▸ (primary)]        │
├──────────────── Conversation (≈ 40%, min 360px) ─┬──────────────── Brief (≈ 60%) ──────────────────────┤
│ role="log" transcript, left-aligned, author label │ Outline (sticky): Overview · Scope · Criteria · Risks │
│ ─ Alice: rough idea …                             │   · Assumptions · Questions (2) · Milestones · Tasks  │
│ ─ Assistant: "I understood … 3 questions"         │   · Execution · References · Conflicts (1)            │
│   ┌ Question card: text · why · [chip][chip][…]   │ Cards per section, click-to-edit fields, add/remove/  │
│   └ free-text answer                              │ move-up/down buttons, "Updated by assistant" markers, │
│ Clarifying round 2 of 3 · [Draft now]             │ inline suggestions (Accept / Keep mine)               │
│ Grounded on: 12 files · 4 decisions ▸             │ Tasks: table grouped by milestone (key, title, kind,  │
│ ┌ composer (autosize) ─────────── 1 204 / 8 000 ┐ │ points, deps chips, risk) + dependency layers view    │
│ │ Ctrl+Enter send · Esc stop        [Send ▸]    │ │ Ready checklist at the bottom                         │
└───────────────────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

* ≥ 1280 px: split panes with a keyboard-resizable separator (`role="separator"`, arrow keys, `aria-valuenow`).
  1024–1279 px: 50/50. < 1024 px: segmented control **Chat | Brief** (`Tabs` component) with a dot badge when the brief
  changed; composer sticky at the bottom.
* History drawer: versions (author, time, summary), diff view (added / removed / changed rows marked with `+`, `−`,
  `~` text and `good-soft` / `critical-soft` / `warning-soft` backgrounds — never colour alone), "Restore as new
  version".
* Conflicts panel: `StatusBadge` per severity (`critical` contradiction, `warning` tension, `muted` duplicate), source
  rendered as `DecisionCard`/ADR excerpt with quote, "Jump to field", resolution actions with required note.
* Apply dialog (`role="dialog"`, `aria-modal`, focus trap, Esc closes, focus returns to the trigger): grouped diff with
  counts, exclude checkboxes, hold choice, role badges ("Needs admin"), approval notice, acknowledgement checkboxes for
  tensions/duplicates; primary button label spells out the effect: "Create 14 tasks on hold".

### 9.3 States

| State | Presentation |
|---|---|
| No sessions | `EmptyState` "Turn an idea into a plan" + three example prompts that prefill the composer |
| New session | Conversation intro text and composer; brief pane shows the section outline as skeleton with "Your brief appears here after the first answer" |
| First load | `Loading` skeletons in both panes; refetches use `Refreshable` (no layout jump) |
| Turn running | Phase line with `role="status"` ("Reading 4 decisions…", "Drafting…", "Validating…"); composer disabled with **Stop**; brief editable, edits buffered |
| Streaming (stage 5) | Provisional reply text (muted until `done`); screen readers get one announcement when complete, not per token |
| Turn failed / invalid output | `ErrorBanner` "The assistant's answer could not be validated — nothing was changed" + Retry |
| Budget paused | `warning-soft` banner "Session budget reached ($1.00). Edit the brief directly, or ask an admin to raise the limit." Composer disabled, brief editable |
| Rate limited | Inline notice with retry time |
| Stream lost | Falls back to polling the session every 3 s until the turn ends; `LiveIndicator` semantics reused |
| Save conflict (409) | Banner "Brief changed by Carol (v8)" → Review diff / Save mine as new version |
| Read-only (viewer or no project role) | Composer and edit controls hidden; "Read-only — viewer" chip; apply preview visible |
| 403 / not found | Existing `ErrorBanner` (Insufficient role) / 404 page |
| Pending approval | Session banner with link to the approval; apply disabled |
| Applied | Success banner with links to created tasks/project; brief read-only; "Re-plan" opens a linked session |

### 9.4 Keyboard and accessibility

* Ctrl/Cmd+Enter sends, Enter inserts a newline (long ideas), Esc stops a running turn (confirm if > 10 s elapsed),
  Alt+Shift+C / Alt+Shift+B focus conversation / brief (announced in a "Keyboard shortcuts" popover; no single-key
  shortcuts). Quick-reply chips are buttons in a `role="group"` with the question as label.
* Transcript `role="log"` with `aria-live="polite"`; only completed assistant messages and new questions are announced.
* All reordering via buttons ("Move up/down"), never drag-only; dependency selection via a searchable checkbox list.
* Landmarks: two `section`s with `aria-labelledby`; the outline is a `nav` with `aria-current` for the visible
  section; version selector is a `listbox`.
* Focus is kept in the composer after sending; after an apply the dialog closes and focus moves to the success banner
  heading.
* Respects `prefers-reduced-motion` (existing `.enter`/`.pulse` rules); hit areas ≥ 40 px via the existing
  `IconButton` pattern.

### 9.5 Design tokens and theme

Uses the existing tokens only (`surface`, `surface-2`, `line`, `ink`, `ink-2`, `accent`, `accent-soft`, status
`*-soft`), `Card`, `Chip`, `StatusBadge`, `Tabs`, `Field`, `textareaClass`, `Button`, `ErrorBanner`, `EmptyState` from
`components/ui.tsx`. Assistant messages carry a small `OrchestratorMark` avatar and label; human messages use the user
avatar; external AI messages use `surface-2` background with an "External AI" chip. "Updated by assistant" fields use
an `accent-soft` left border (plus text marker). Dark/light work automatically through the token definitions in
`globals.css`; no new colours. New components live in `apps/web/src/components/assistant/` (`studio.tsx`,
`transcript.tsx`, `brief-editor.tsx`, `brief-diff.tsx`, `apply-dialog.tsx`, `conflicts.tsx`, `explain-button.tsx`) and
a `use-turn-stream.ts` hook (fetch stream reader with SSE parsing, abort, polling fallback).

## 10. Stages, acceptance criteria and tests

| Stage | Content | Acceptance criteria | Tests |
|---|---|---|---|
| **0** | Accept ADR-033; coordinate with ADR-030 owner (conversation tables) and multi-account work (ADR-032 number) | ADR merged; ADR-030 plan references `conversation_messages` | — |
| **1 — Hold + foundations** (after PR #12 merges) | `tasks.scheduling_hold`/`origin`, scheduler skip, hold/release routes + "On hold" chip; `conversations`, `conversation_messages`, `assistant_turns`, `brief_drafts`; brief schema, verify, diff, patch; turn policy; budget scopes `conversation`/`user`, nullable project scope; `assistant` role + read tools; demo responders for `planning_assistant` | Held tasks are never selected by `schedule()`; release makes them schedulable and is audited; brief with cycle/unknown dependency fails verify; patch on a locked path yields a suggestion; the turn schema rejects questions when rounds are exhausted | core: scheduler hold, verify matrix, diff by key, patch locks, policy bounds, budget scopes; db: draft version uniqueness + stale base 409, turn idempotency by `client_turn_id`; server: hold/release RBAC + ACL + audit |
| **2 — Planning Studio for existing projects (first slice)** | `AssistantService` with grounding (repo index, decisions, memories, health scan, proposals), phase SSE turns, drafts API, consistency check with citation verify, apply preview/apply for `create_task` + `record_memory` + `record_decision` (milestones in memory), shared task service, Planning tab + studio UI + apply dialog | A user goes idea → ≤ 3 clarifying rounds → brief → edits → apply → tasks exist on hold with dependencies and `origin`, visible only to project members; nothing is created without confirmation; a contradiction blocks apply until resolved; changed project state between preview and apply answers 409; repeated apply with the same key creates nothing new; viewers can read but not send turns; budget pause leaves the brief editable | core: grounding delimiting + redaction, conflict citation/quote verify and fingerprint stickiness, apply plan ordering/exclusions/hash; server (mock provider through the real SSE route): full flow, RBAC/ACL matrix (viewer, operator non-member, operator member, admin), rate limit 429, `turn_in_progress` 409, budget pause, invalid output → nothing changed, plan hash 409, idempotent apply, audit rows, event visibility; injection fixtures (poisoned README/ADR) → no side effects; web: transcript + question chips keyboard flow, brief editor versioning, apply dialog focus trap and not-colour-only diff |
| **3 — New project from idea** | Private sessions without project, admin hand-off (`visibility = admins`), `create_project` + optional `patch_project` (autonomy/budget) with gates, `/planning` page, projects page entry | Operator can draft privately; only an admin/owner can apply project creation; autonomy ≥ 3 or budget above threshold creates an approval and nothing until approved; rejection/expiry creates nothing; private session content invisible to admins except metadata | server: visibility matrix, hand-off audit, approval path incl. expiry (ADR-023), transaction rollback when one task fails validation |
| **4 — Explain, Ask, Refine** | `explain` (cached), `ask`, `refine_task` (patch task + child tasks), entry points on runs/decisions/approvals/costs/tasks; "Plan this" on proposals when PR #12 UI exists | Explain answers cite the run/decision records; a second Explain on the same unchanged record is a cache hit with zero cost; Refine can only patch tasks in BACKLOG/READY/BLOCKED; running tasks are never changed | core: explain grounding for runs, refine plan ops; server: cache hit ledger row, status guard 409 |
| **5 — Token streaming + provider accounts** | `ModelProvider.streamStructured?` for Anthropic/OpenAI adapters, `delta` events; account selection per §4.5 once ADR-032 stage 2 exists; "Billed to" chip | Deltas appear for supporting adapters, phases otherwise; final object still validated; assistant spend attributed to account and requesting user; no cross-owner failover on 429 | adapter tests against local fake APIs through the real SDKs (existing pattern); router account order tests |
| **6 — Room and MCP** (with ADR-030 stages 1–3) | `room` conversations on the same tables, room status messages for sessions/applies, `@orchestrator plan` → planning session, `@assistant` in room, milestones table in apply (`create_milestone`), MCP tools for sessions and suggestions | External AI can read the brief and post suggestions but cannot trigger turns, edit, resolve or apply; room shows session start/apply cards; milestones created on apply | MCP authorization tests (scopes, ACL, rate limits), "external message → no model call" test, room rendering tests |

Quality evaluation (from stage 2): a fixed set of ~10 idea prompts (German and English) run against the configured
model with a rubric (clarifying questions relevant, brief complete, tasks independent and testable, estimates
plausible, no invented references). Tracked metrics in production: clarifying rounds used, turns per applied session,
share of sessions applied, human edits per brief, tasks later cancelled. These measure usefulness; they do not
guarantee good plans.

## 11. Trade-offs and open questions

1. **Apply through "existing routes":** literally calling the HTTP routes (e.g. `app.inject`) keeps code paths
   identical but cannot be atomic and duplicates auth handling. The plan extracts shared services used by routes and
   the executor (same schemas, checks, events, audit) and runs one transaction. Reviewers should confirm this reading.
2. **Hold semantics (F1):** a `scheduling_hold` column is orthogonal and minimal. The alternative — making `BACKLOG`
   non-schedulable — matches ADR-030's board rule but would change PR #12's auto-accepted improvements at autonomy ≥ 3
   and existing API behaviour. Decide together with ADR-030 stage 1.
3. **Interactive turns outside the job queue:** faster and simpler streaming, but a process crash loses the running
   turn (user retries). If this is unacceptable, turns can move to a job with a cross-instance delta relay later.
4. **Private drafts and admins:** is metadata-only visibility for admins right, or must owners be able to read all
   content for compliance? Should private drafts count against a project budget once applied?
5. **Milestones before ADR-030 stage 1:** kept in memory and task text. Alternatively pull the `milestones` table and
   `tasks.milestone_id` forward into stage 2 — cleaner, but couples this work to ADR-030's schema decisions.
6. **Token streaming support varies** by provider and by OpenAI-compatible local servers; structured-output streaming
   may be unavailable, so phases remain the baseline.
7. **Estimates are rough:** points → cost/token budgets use project history from `usage_ledger` when at least ~10
   completed tasks exist, otherwise static defaults. The UI must say "estimate".
8. **Consistency coverage is partial:** only recorded decisions, memories and ADR files the index can parse. Implicit
   conventions in code are only caught if file summaries mention them. False positives cost user attention; uncited
   conflicts are dropped, which may hide real but badly cited ones.
9. **Retention and GDPR:** retention period for archived sessions, user data export/delete, and telling users which
   vendor processes their conversation (depends on ADR-032 account choice). Needs a decision before multi-team use.
10. **Language:** briefs follow the session language; pipeline agents then work on German task text. Should task
    titles/goals be generated in English for code-facing consistency? Proposed default: session language, with a
    per-project "task language" setting.
11. **Viewer access to Explain:** useful for stakeholders but costs money; default off, fast tier only when on.
12. **ChatGPT/Claude.ai as MCP participants** likely need OAuth 2.1 on `/mcp` (multi-account research §5.3); bearer-only
    limits participants to Claude Code, Codex and Cursor at first.

## 12. Non-goals

Voice, file/image uploads into the conversation, web browsing by the assistant (`research.web` stays unbuilt), the
assistant executing or approving anything, automatic application of briefs at any autonomy level, real-time
co-editing of the same field (last-writer-wins with 409 on stale base instead), GitHub Issues/Projects export (ADR-030
stage 4), cross-project portfolio planning.

## 13. ADR-033 (proposal — to be added to `docs/DECISIONS.md` when accepted)

## ADR-033 — Planning assistant: one conversation model with the Project Room, versioned briefs, human-confirmed apply
* **Context:** The owner wants an AI assistant in the web app that refines rough ideas and plans into precise project
  structure (request 2026-09-14). ADR-030 plans a Project Room chat and a roadmap proposal but nothing is built. The
  orchestrator must remain the only decision maker (spec §35); model output and repository content are untrusted;
  budgets and approvals apply to everything. Tasks created through the API start `READY`, and the scheduler starts
  `BACKLOG` and `READY` tasks.
* **Decision:**
  * A single assistant engine (`packages/core/src/assistant`, agent role `assistant`) serves Planning Studio, Refine,
    Explain and Ask. It has read-only tools through the `ToolRouter` only; it cannot create, edit, start, approve or
    deploy anything.
  * **One conversation model:** `conversations` (kinds `room | planning | refine | explain | ask`) and
    `conversation_messages` replace ADR-030's `room_messages` (refines ADR-030's data model). The assistant is a
    participant (`author_type = assistant`); planning sessions are threads linked from the room. External AI messages
    (MCP) are untrusted, never trigger assistant turns, and can only create suggestions.
  * **Briefs** are zod-validated (`PlanningBriefSchema`), stored as immutable versions; the assistant changes them
    through allow-listed, key-addressed patches; fields edited by humans are locked and assistant changes to them become
    suggestions. Clarifying rounds (default 3), turns, model calls per turn, and spend (new budget scopes
    `conversation` and `user`) are bounded server-side.
  * **Consistency:** briefs are checked against recorded decisions, memories, ADR/STATE documents in the repository
    index, health scans and proposals. Conflicts must cite a source and quote; contradictions block apply until a human
    changes the brief, proposes a superseding decision (gated as `architecture_change`) or dismisses it with a reason.
  * **Apply:** a deterministic, hashed apply plan is previewed as a diff and executed only after explicit confirmation,
    in one transaction through the same services, schemas, role/ACL checks, events and audit as the existing routes;
    idempotent by key. Project creation, autonomy ≥ 3, budget above the `high_cost` threshold and supersede proposals
    go through approvals. Created tasks carry `origin` and a `scheduling_hold` (default on) that the scheduler
    respects; decisions are recorded by the orchestrator service with the assistant as consulted agent.
  * **Execution:** assistant turns run inline in the API process with a lease, a 120 s timeout and idempotent
    `client_turn_id`, streaming phases (later token deltas) as SSE on the turn's own response; only content-free
    lifecycle events go through the event bus. This is a scoped exception to ADR-004. Assistant turns are not cached
    (ADR-014); Explain is.
  * **Visibility:** project sessions follow ADR-022; sessions without a project are private to the creator (admins
    see metadata) until shared for hand-off.
  * **Accounts:** instance providers pay until provider accounts exist; then the requesting user's own grant is
    preferred for assistant turns (see the provider-accounts ADR, proposed as ADR-032); subscription logins are never
    used.
* **Consequences:** New tables (`conversations`, `conversation_messages`, `assistant_turns`, `brief_drafts`,
  `brief_suggestions`, `brief_conflicts`, `brief_applications`), task columns `scheduling_hold`, `hold_reason`,
  `origin`, ledger columns `conversation_id`, `requested_by_user_id`; ADR-030's room is built on the conversation
  tables; ADR-030's roadmap proposal becomes Planning Studio apply. Routes live in
  `apps/server/src/routes-assistant.ts` (ADR-016 pattern). Numbering: ADR-031 is reserved by the plugin scout draft,
  ADR-032 is recommended for provider accounts.
* **Status:** Proposed (2026-09-14)
