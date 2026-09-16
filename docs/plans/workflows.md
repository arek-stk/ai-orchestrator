# Plan: Workflows — visueller Multi-Agent-Workflow-Builder und -Runner

Status: **stage 1 in review** (ADR-037 below). Owner input: mockup "Marketing Kampagne" (2026-09-16), "das ist cool".

## Zusammenfassung (Deutsch)

Workflows sind gespeicherte, versionierte Abläufe (gerichtete azyklische Graphen) pro Projekt: ein **Ziel**, ein
**KI-Orchestrator**-Knoten, beliebig viele **Agenten** (Rolle, Tool aus dem AI-Hub-Katalog, Modell, Temperatur,
Max. Tokens, Anweisungen, Ausgabeformat) und **Zusammenführung/Finale**. Der Editor unter `/workflows/[id]` zeigt den
Graphen als Canvas (Pan/Zoom, Auto-Layout, Drag, Kanten verbinden/trennen, Minimap), eine tastaturbedienbare
Gliederung als gleichwertige Alternative, ein Agenten-Panel wie im Mockup und eine JSON-Code-Ansicht mit
Validierungsfehlern.

**Ehrlichkeit ist die zentrale Regel:** Ein Agent ist nur *ausführbar*, wenn sein Tool nativ oder OpenAI-kompatibel
angebunden, verbunden und mit einem verfügbaren Modell in der Registry routbar ist — dieselbe Logik wie im AI Hub.
Midjourney, Runway, ElevenLabs & Co. dürfen im Entwurf vorkommen, werden aber als „nicht ausführbar – Integration
fehlt / keine offizielle API“ markiert. Ein Lauf blockiert dann vorab mit einer Liste oder überspringt diese Knoten
sichtbar („übersprungen – nicht ausführbar“). Erfolg wird nie vorgetäuscht. Tool-Schalter (Websuche, Dateien
analysieren, Bilder generieren) sind nur aktiv, wenn das Tool im Tool-Router existiert und für Workflows angebunden
ist — in Stufe 1 ist das für keines der drei der Fall, sie sind deshalb mit Begründung deaktiviert.

**Ausführung (Stufe 1):** Server-seitiger Lauf mit Schritt-Datensätzen über die Job-Queue, topologische Reihenfolge
mit begrenzter Parallelität, Fortschritt per SSE. Echte Modellaufrufe nur für ausführbare Text-Agenten über die
bestehende Agent-Runtime (Budget-Gates, Usage-Ledger). Vorgänger-Ausgaben gehen als abgegrenzter, nicht
vertrauenswürdiger Kontext weiter. Kosten- und Zeitlimits pro Lauf. Ergebnisse sind **Run-Artefakte** (Markdown/Text);
Schreiben ins Repository kommt erst in Stufe 2 über Change Set → PR mit Freigaben. Im Demo-Modus simuliert ein
deterministischer Executor den Lauf, klar als „Demo“ markiert, ohne erfundene Kosten. Läufe posten Start und Ende in
den Project Room und respektieren eine aktive Autopilot-Session (Budget, Zeitfenster, Kill-Switch).

---

## 1. Goals and non-goals

Goals (stage 1): design, validate, version and run multi-agent text workflows per project, with an honest per-node
executability flag, bounded execution, real cost data and a UI that matches the AI Hub.

Non-goals (stage 1): executing image/video/voice tools, web search, repository writes from workflows, publishing,
model-decided routing inside a run, scheduled/triggered workflows, collaborative real-time editing.

## 2. Data model (migration `0004_workflows`, numbered after main's `0003`)

| Table | Fields |
|---|---|
| `workflows` | `id` (`wfl_…`), `project_id` → projects (cascade), `name` (≤ 80), `description` (≤ 300), `status` (`active \| draft \| archived`), `version` (int, optimistic lock), `definition` jsonb, `created_by`/`updated_by` → users (set null), `created_at`, `updated_at` |
| `workflow_versions` | `workflow_id` → workflows (cascade), `version`, `definition` jsonb, `name`, `created_by`, `created_at`; PK (`workflow_id`, `version`); every save appends one row |
| `workflow_runs` | `id` (`wfr_…`), `workflow_id` (cascade), `project_id` (cascade), `workflow_version`, `definition` jsonb (snapshot), `status` (`queued \| running \| succeeded \| partial \| failed \| blocked \| cancelled`), `mode` (`live \| demo`), `on_non_executable` (`block \| skip`), `limits` jsonb (`maxParallel`, `maxCostUsd`, `maxDurationMs`), `session_id` → autopilot_sessions (set null), `blockers` jsonb, `reason`, `cost_usd`, `tokens`, `started_by`, `created_at`, `started_at`, `finished_at` |
| `workflow_run_steps` | `id`, `run_id` (cascade), `node_id`, `node_type`, `status` (`pending \| running \| succeeded \| failed \| skipped \| blocked \| cancelled`), `reason`, `agent_run_id` (ledger link), `model_id`, `provider`, `cost_usd`, `tokens`, `summary` (≤ 300), `attempts`, `started_at`, `finished_at`; unique (`run_id`, `node_id`) |
| `workflow_artifacts` | `id` (`wfa_…`), `run_id` (cascade), `node_id`, `name`, `format` (`markdown \| text \| json`), `content` (≤ 100 000 chars), `size`, `created_at` |

Definition (`schemaVersion: 1`, zod in `packages/core/src/workflows/types.ts`): `nodes[]` (discriminated by `type`:
`goal`, `orchestrator`, `agent`, `join`, `finale`; each with `id`, `label`, `position`), `edges[]` (`id`, `source`,
`target`). Agent nodes: `role` (existing `AgentRole`), `toolId` (Hub catalog id), `model` (registry id or null =
routed within the tool's models), `temperature` 0–2, `maxTokens` 256–16 000, `enabledTools[]`, `output`
(`format`, `artifactName`), `instructions` (≤ 4 000), `description`, `tags` (≤ 6).

Validation (`validateWorkflowDefinition`): schema, ≤ 40 nodes / ≤ 120 edges, unique ids, no dangling or duplicate edges,
no self loops, acyclic, exactly one goal (no incoming edges), exactly one finale (no outgoing edges) reachable from the
goal, every node reachable from the goal (warning if a node cannot reach the finale), agent parameter ranges, known
tool ids, tool toggles only for available tools, no secret-looking values anywhere (`findSecrets`). Errors block saving
as `active` and running; drafts may be saved with errors so work is never lost.

In-memory parity: `packages/core/src/testing/memory-workflows.ts` implements the same ports; one contract test suite
runs against both it and the Drizzle repositories on PGlite.

## 3. Execution semantics

* **Start** (`POST /api/workflows/:id/runs`): validate the saved definition; compute executability; resolve limits
  (request ≤ instance maximum, clamped by an active autopilot session's remaining budget and end time); snapshot the
  definition into the run. With `onNonExecutable = block` and at least one non-executable agent, the run is stored as
  `blocked` with the blocker list and never enqueued. With `skip`, those steps are `skipped` (`not_executable`) up
  front. Otherwise one durable job `workflow.run` (dedupe per run) is enqueued.
* **Scheduling:** `readyWorkflowNodes` returns nodes whose predecessors are all terminal, in topological order;
  the runner starts at most `maxParallel` (1–4) at a time and fills slots as steps finish. One job runs the whole
  workflow (the worker extends its lease); after a crash the re-claimed job resets `running` steps to `pending` and
  continues (at-least-once, like pipeline steps).
* **Node behaviour:** `goal` succeeds with its text; `orchestrator` is deterministic in stage 1 (writes the execution
  plan from the topology — it does not call a model and does not decide anything); `agent` calls the executor;
  `join`/`finale` concatenate the available upstream artifacts into one artifact, naming skipped/failed inputs.
* **Failures:** a failed agent marks all its descendants `skipped` (`upstream_failed`); independent branches continue.
  An agent downstream of a *skipped* node runs with an explicit note that the input is missing.
* **Final status:** `succeeded` only when every step succeeded; `partial` when something was skipped as
  non-executable but nothing failed; `failed` on any failure; `blocked` when a cap was hit (cost, time, autopilot);
  `cancelled` on cancel or autopilot kill. Conditional updates guarantee a cancel is never overwritten.
* **Caps:** before each agent step the runner checks spend (sum of step ledger costs) against `maxCostUsd` and the
  deadline; the runtime call receives the remaining run budget divided by the steps starting together, so parallel
  calls cannot overshoot the cap by design. In-flight calls finish within the runtime timeout.
* **Live executor:** `AgentRuntime.run` with the workflow agent definition (`workflow_agent_output`: `summary`,
  `content`, `confidence`), the node's role, `pinnedModelId` = node model or the tool's first available model, and a new
  `allowedModelIds` restriction so fallbacks stay within the tool's own provider account (a "Claude" node is never
  answered by another vendor). Budget scopes global/project apply as for every call; the ledger rows are the cost data.
* **Demo executor** (server demo mode): deterministic German placeholder outputs derived from node id, role and label,
  optional latency; no model call, no ledger rows, costs shown as "Demo – keine echten Kosten". Integration flags still
  apply (a Midjourney node is not executable in demo mode either).
* **Temperature** is stored and shown, but the provider port has no temperature parameter yet; the panel says so.

## 4. Relation to existing features

* **Task pipeline:** workflows do not create tasks or pipeline runs and never touch code. A later stage can add a
  "create task from artifact" action; code changes stay in the pipeline (plan → implement → review → PR).
* **Autopilot (ADR-034):** a run started while the project is in an active session records `session_id`, is capped by
  the session's remaining budget (ledger spend of the session's pipeline runs plus workflow runs of the session) and end
  time, and is cancelled when the session is killed. Workflows never auto-start in a session in stage 1.
* **Project Room (ADR-030):** start and finish post one `status` notice each (`authorType: orchestrator`, dedupe keys
  `workflow-run:<id>:started|finished`, ref `workflowRunId`).
* **AI Hub (§4.16):** the tool list and integration labels mirror the Hub catalog (`WORKFLOW_TOOLS` in core; a test
  keeps it in sync with `apps/web/src/lib/hub/catalog.ts`); logos and tokens are reused.

## 5. Safety and honesty rules

1. Node instructions, the goal text and upstream outputs are untrusted: they are passed inside
   `<<<UNTRUSTED …>>>` delimiters (delimiter sequences inside content are neutralised), redacted with
   `redactSecrets`, length bounded, and the system prompt says they are data, not instructions.
2. Model output never executes tools: the workflow agent has no tools, its output is stored as an artifact only.
3. Output targets are run artifacts only in stage 1. The "Ziel" field is an artifact name, normalised and without
   `..`; repository paths, publishing and anything gated wait for stage 2 (change set → PR through the tool router
   and approvals).
4. Everything is bounded: nodes, edges, text lengths, parallelism, tokens per node, cost and time per run, artifact size,
   versions listed, events returned.
5. No secrets in definitions (rejected with an error), no provider keys in the web client.
6. Executability is computed server-side from provider accounts and the model registry; the UI never claims more.
7. No new dependencies (ADR-031): canvas, layout, drag and drop and JSON editing are hand-rolled.

## 6. API

`GET /api/workflows/meta`, `GET|POST /api/workflows`, `POST /api/workflows/validate`,
`GET|PUT|DELETE /api/workflows/:id`, `GET /api/workflows/:id/versions`, `GET|POST /api/workflows/:id/runs`,
`GET /api/workflow-runs/:id`, `GET /api/workflow-runs/:id/events`, `GET /api/workflow-runs/:id/artifacts/:artifactId`,
`POST /api/workflow-runs/:id/cancel`. Viewers read, operators edit and run (per-project ACL, ADR-022), mutations are
audited without content, CSRF origin check as everywhere, rate limits on saves (30/min), validation (60/min) and runs
(10/min). SSE events (content-free): `workflow.saved`, `workflow.run.started`, `workflow.step.updated`,
`workflow.run.finished`.

## 7. Stages

| Stage | Scope |
|---|---|
| **1 (this PR)** | Definitions + versions, validation, executability, templates, editor (canvas, outline, panel, code view), runs with live/demo executors, caps, artifacts, SSE, room notices, autopilot caps, tests |
| 2 | Repository output targets via change set → PR with approvals; "create task from artifact"; temperature in the provider port; version diff/restore UI |
| 3 | Tool use inside workflows once `research.web` / `repository.read` exist in the tool router (read-only first), image/voice/video adapters when official APIs are integrated as providers |
| 4 | Model-planned orchestrator node (council-style, bounded), triggers/schedules, autopilot-started workflows under session gates |

## 8. ADR-037 (proposal, added to `docs/DECISIONS.md` with this PR)

See `docs/DECISIONS.md` → ADR-037. Numbering: 031 and 034 are accepted; 032, 033, 035 and 036 are reserved by drafts,
so this is the next free number.
