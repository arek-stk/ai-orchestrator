# AI Orchestrator — Architecture

> Living document. Every structural change must be reflected here **and** recorded in
> `docs/DECISIONS.md` (Decision Memory). Before making an architectural decision, check the existing
> decisions first. Current build progress is tracked in `docs/STATE.md`.

## 1. Purpose

A web application hosting an **autonomous, auditable, cost-aware orchestrator** that manages many
software projects at once. The orchestrator is the single decision-making instance. Specialist agents
are activated **on demand**, give structured opinions or produce artifacts, and never decide on
their own.

```
User → Orchestrator → Plan → specialist agents → synthesis/decision → implement → verify
     → review → debug (bounded) → GitHub branch/commit/PR → CI → approval gate → next task
```

## 2. Topology

```
┌──────────────────────┐        /api (rewrite)       ┌────────────────────────────────────────┐
│ apps/web (Next.js)   │ ──────────────────────────▶ │ apps/server (Fastify, Node.js)          │
│ Dashboard, project   │ ◀── SSE /api/events/stream  │  • HTTP API + auth + RBAC + rate limits │
│ tabs, approvals      │                             │  • Event bus → SSE fan-out              │
└──────────────────────┘                             │  • Scheduler tick (fairness/aging)      │
                                                     │  • Job workers (durable DB queue)       │
                                                     │  • Orchestrator (pipeline engine)       │
                                                     └───────┬───────────────┬────────────────┘
                                                             │               │
                                     ┌───────────────────────▼──┐   ┌────────▼─────────────────┐
                                     │ PostgreSQL (prod)        │   │ Integrations              │
                                     │ PGlite embedded (dev)    │   │  • Model providers        │
                                     │ Drizzle ORM + migrations │   │  • GitHub API + webhooks  │
                                     └──────────────────────────┘   │  • Docker sandbox runner  │
                                                                    └───────────────────────────┘
```

`SERVER_ROLE=all|api|worker` lets the same server binary run API and workers separately in
production (requires real PostgreSQL; PGlite is single-process).

## 3. Repository layout

| Path | Responsibility | IO allowed |
|---|---|---|
| `packages/core` | Domain contracts, orchestrator decision loop, pipeline engine, scheduler, DAG, model router, tool router, budget guard, council, context builder, CI classifier, approval policy. Depends only on **ports** (interfaces). | No |
| `packages/db` | Drizzle schema, migrations, client factory (pg / PGlite), repository implementations of core ports, durable job queue. | DB |
| `packages/integrations` | Model providers (Anthropic SDK, deterministic Mock), GitHub client (Octokit + in-memory fake), sandbox runners (Docker, Null). | Network/Docker |
| `apps/server` | Composition root: config, HTTP routes, auth, SSE, workers, scheduler, seeding. | All |
| `apps/web` | Next.js UI. Talks only to the server API. | HTTP |

Hexagonal rule: `core` never imports from `db`, `integrations` or `apps`.

## 4. Core concepts

### 4.1 Task contract
See `packages/core/src/domain/task.ts`. Every task has goal, priority, dependencies (DAG),
acceptance criteria, risk, complexity, token budget, max cost, max attempts.

### 4.2 Pipeline engine
Stages: `INTAKE → ANALYZE → PLAN → DESIGN → IMPLEMENT → TEST → REVIEW → SECURITY → VERIFY → COMMIT → PUSH → PR → CI → DEPLOY → MONITOR`.

* `planStages(task, projectProfile)` decides which stages run and records a **skip reason** for the
  others (e.g. docs-only change → no SECURITY, no DESIGN).
* Each stage transition is **checkpointed** in `pipeline_runs`; a crashed worker's job lock
  expires and another worker resumes from the last checkpoint (at-least-once, stages idempotent).
* Stop conditions per run: `maxIterations`, `maxCostUsd`, `maxTokens`, `maxRuntimeMs`,
  `maxDebugAttempts`. Hitting one → `BLOCKED` with a machine-readable reason + blocker analysis.
* Test/CI failure → Debug agent (reproduce → root cause → fix → retest). Failure fingerprints are
  stored in Failure Memory; an identical fingerprint after a "fix" counts as a non-progressing attempt.
* CI **infrastructure** failures (runner lost, timeouts, rate limit, network) are classified and
  retried/queued — they never trigger code changes.

### 4.3 Orchestrator decision loop (bounded)
```
observe → selectNextTask (scheduler) → clarify? → plan → selectAgents → buildMinimalContext
→ consult (council only if complexity/risk warrants) → synthesize → confidence ≥ threshold ? execute : escalate
→ verify → debug (≤ maxDebugAttempts) → replan or BLOCK → update memory/state → next
```
One loop iteration = one durable job (`pipeline.step`). There is no unbounded in-memory `while`.

### 4.4 Agents
Contract: `canHandle / plan / execute / verify` (`packages/core/src/agents/contract.ts`).
MVP agents: Planning, Build, Test, Debug, Code Review. Registered definitions (used by council):
Architecture, Security. Specialists (ADR-015): Documentation (docs tasks, `docs.write` only), Release readiness
(before DEPLOY), DevOps (health scans only), Research (explicit request only), Health scanner and File summarizer
(ADR-013/014). Each definition declares role, default capability tier, output schema,
tool permissions. Agents return **structured JSON validated with zod**; invalid output is a failed
attempt, never silently accepted.

### 4.5 Council
`consult(agents, question)` runs selected agents in parallel with `maxRounds` (default 2),
`confidenceThreshold` (0.80), token cap and timeout. Synthesis computes agreement-weighted
confidence. Below threshold after max rounds → one targeted expert, then escalate to human.
Only the orchestrator writes the `decisions` row.

### 4.6 Model layer: swappable models & providers (ADR-005)
* **Providers are adapters** behind the `ModelProvider` port: Anthropic, OpenAI, Google Gemini,
  any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter, Mistral, DeepSeek, Groq…), Mock.
* **Models are data** (`model_configs`): provider, model id, context window, max output, $/MTok,
  latency class, coding/reasoning scores, capabilities, enabled flag — editable at runtime in the UI.
* **Selection precedence:** run pin → project role override → global role override → automatic routing.
* `ModelRouter.select(requirements)` filters by hard constraints (enabled, provider credential present,
  context size, max output, structured output/vision, remaining budget) then minimises expected cost
  subject to a quality floor derived from agent role, task complexity, risk and prior failures
  (escalates after failed attempts).
* **Fallback chain** on outage/429/5xx, preferring a *different provider* for resilience.

### 4.7 Tool router
Agent → tool request → permission check (role allowlist) → project scope check → security check
(path traversal, protected branches, secret patterns) → cost check → execute → audit log.
Agents never get raw shell. Commands run only inside the sandbox and only from the project's
allow-listed command profile (e.g. `npm test`).

### 4.8 Context optimisation
Repository index (tree + per-file summaries keyed by blob SHA) → relevance ranking for the task
(path/symbol/keyword scoring + dependency neighbours + failure memory hits) → greedy packing into the
model's token budget. Summaries are cached by content hash and reused while the SHA is unchanged.
The fast-tier File Summarizer fills missing summaries (bounded batches) in ANALYZE and health scans; deterministic,
side-effect-free agents use the TTL agent output cache in `cache_entries`, whose hits are recorded as zero-cost ledger
rows with the saved amount (ADR-014).

### 4.9 Memory
`memories` table with scopes `project | task | failure`. Decisions have their own table for
the audit trail (question, options, consulted agents, evidence, decision, reason, confidence, cost).

### 4.10 Scheduler
Score = `projectPriority*w1 + taskPriority*w2 + agingBonus(waitTime) + riskAdj − costPressure`.
Hard gates: DAG readiness, per-project concurrency, global agent capacity, budget state, autonomy level,
pending approvals. Aging guarantees no project starves.

### 4.11 Autonomy & approval gates
Levels 0 Observe · 1 Suggest · 2 Execute (no publish) · 3 Autonomous Dev (PR) · 4 Autonomous Delivery.
Gated actions (configurable per project): production deploy, DB migration, destructive data ops,
large architecture change, secrets/permissions, cost above threshold, external services,
critical infra. A gate creates an `approvals` row, emits `approval.required`, and parks the run in
`WAITING` until a human decides.

Hard rule (ADR-031): `dependency_addition`. Every new dependency (manifest or lockfile-only package, workflow `uses:`,
MCP server, Claude plugin, VS Code extension) needs a human at every autonomy level and cannot be disabled in the gate
configuration. It is detected from the change set after IMPLEMENT, before sandbox runs and at COMMIT, with a tool router
backstop on `git.commit`; an approval covers exactly the fingerprinted set of additions.

### 4.12 Budgets
Global daily → project → task → agent-run. Before every model call `BudgetGuard.check()` returns
`allow | degrade (cheaper model / smaller context / reuse cached decision) | pause`. Every call writes
a `usage_ledger` row.

### 4.13 Events
Typed domain events (`task.created`, `agent.completed`, `test.failed`, `ci.failed`,
`approval.required`, `project.blocked`, …) are persisted to `events` and published on the in-process bus;
SSE clients subscribe with project filters. Workers react to events by enqueueing jobs — no polling
agents. On PostgreSQL, events fan out across instances with `LISTEN/NOTIFY` carrying only the event id;
listeners load the row, deduplicate by id and replay gaps after reconnects (ADR-024).

### 4.14 Operations
* **Deployment (ADR-020):** esbuild bundle `apps/server/dist` (migrations included), `apps/server/Dockerfile`,
  `docker-compose.yml` with PostgreSQL; the CI image build runs on pull requests.
* **Metrics (ADR-021):** `GET /api/metrics` (Prometheus text; `METRICS_TOKEN` bearer or admin session): runs and jobs
  by status, active agent runs, pending approvals, spend today, HTTP requests/durations by route template, worker job
  outcomes. Logs carry `reqId` (echoed as `x-request-id`) and redact credentials.
* **Approval expiry (ADR-023):** the scheduler tick expires approvals older than `APPROVAL_TTL_HOURS` and blocks
  their run with a reason.

## 5. Security architecture
* Auth: GitHub OAuth; DB-backed sessions (random 256-bit token, only SHA-256 hash stored, httpOnly,
  SameSite=Lax, Secure in prod). Dev login only when `ALLOW_DEV_LOGIN=true` and not production.
* RBAC: global roles `owner | admin | operator | viewer` + per-project membership. With `PROJECT_ACL=enforced`
  (production default) operators/viewers only see and act on member projects, with the lower of global and
  membership role; owners/admins see all (ADR-022).
* Mutating requests require same-origin `Origin` header (CSRF) and an authenticated session.
* Secrets (GitHub tokens, provider keys) encrypted at rest with AES-256-GCM (`ORCH_ENCRYPTION_KEY`),
  never placed into model context, redacted from logs.
* Rate limiting per IP/session; GitHub webhooks verified with HMAC-SHA256 (timing-safe).
* Orchestrator never writes to the default branch; branch protection is re-checked before push.
* Sandbox: `docker run --network none --read-only --cap-drop ALL --pids-limit --memory --cpus`,
  non-root user, workspace tmpfs. No host execution of agent-provided commands.
* Audit log for every tool execution, approval decision, auth event and settings change.

## 6. Failure recovery
| Failure | Handling |
|---|---|
| Worker crash | Job lock (`locked_until`) expires → job re-claimed → resume from checkpoint |
| Model unavailable / 5xx / 429 | SDK retries → router fallback model → job retry with backoff |
| GitHub unavailable | Operation stays queued, exponential backoff, run `WAITING` |
| CI infra failure | Classified `infra` → re-run CI, no debug agent |
| CI code failure | Classified `code` → debug loop (bounded) |
| Budget exhausted | Run `PAUSED`, `budget.exhausted` event, dashboard alert |

### 4.14 Autonomous product improvement (ADR-013)
`HealthScanner` (`packages/core/src/intelligence`) runs as one bounded `project.health_scan` job: deterministic signals →
health score (persisted on `projects.health_score` and in `health_scans`) → heuristic proposals + ≤ 1 scan-agent and
≤ 1 DevOps call under a per-scan cost cap → ROI-ranked, fingerprint-deduplicated `improvement_proposals`. Proposals
become BACKLOG tasks when accepted via API, or automatically only at autonomy ≥ 3 for low-risk, small-effort proposals
(capped). API: `apps/server/src/routes-health.ts`. Events: `project.health_scanned`, `improvement.proposed|accepted|dismissed`.

### 4.15 Project Room and conversations (ADR-030)
One conversation model for every chat surface: `conversations` (one `room` per project; planning, explain and council
kinds later) and `conversation_messages` (typed author and intent, plain-text body, refs, one-level threads, `seq`
cursor, dedupe key). `RoomService` (`packages/core/src/room`) sanitises and redacts untrusted content; the composition
root wraps the event recorder with `withRoomProjection`, so allow-listed orchestrator events become deduplicated,
per-run capped room notices. API: `apps/server/src/routes-room.ts`; live updates are content-free `room.message` events
on the SSE stream.

### 4.15a Board, milestones and leases (ADR-030 addendum 2)
Kanban board, milestones and roadmap are views over tasks. `packages/core/src/board` holds the pure rules (`board.ts`: column
mapping, move plans, ordering, WIP; `milestones.ts`; `leases.ts`: glob overlap, conflicts, expiry) and the use cases
(`BoardService`, `LeaseService`). `tasks.scheduling_hold` keeps cards from being scheduled until a person releases them; the
scheduler also skips tasks owned by people and tasks with a foreign task lease, and IMPLEMENT/COMMIT wait on overlapping path
leases. Persistence: `packages/db/src/board-repositories.ts`; API: `apps/server/src/routes-board.ts`; web: Board and Roadmap
project tabs (`project-board.tsx`, `project-roadmap.tsx`, pure helpers in `lib/board.ts`).

### 4.16 AI Hub (web)
`/hub` lets users discover AI tools and connect the ones the orchestrator can use. The UI (`apps/web/src/components/hub`)
consumes only the `HubService` interface (`apps/web/src/lib/hub/service.ts`); pure search/category/filter/sort logic lives
in `lib/hub/filter.ts`, shareable view state in `lib/hub/url-state.ts`, the static catalog in `lib/hub/catalog.ts`.
* **`ApiHubService` (live):** connections are derived from `/api/providers` and `/api/models` (a tool is usable only when
  an enabled, available registry model routes through its account, mirroring `DefaultProviderResolver`); usage comes from
  `/api/costs` grouped by provider. Connecting a native or OpenAI-compatible tool calls the admin-only
  `PUT /api/providers/:id` (key encrypted at rest, audited); disconnecting calls `DELETE`. Environment accounts are
  read-only. The key is held only in component state for the request; only the display model preference is stored locally.
* **`MockHubService` (demo):** simulated latency and optional failures (`?simulateError=1`), connections in
  `localStorage`, never accepts credentials, never reports usage. The page uses it when the server runs in demo mode;
  `?source=live|demo` switches explicitly.
* **Honesty rules** (unit tested): `native` only for OpenAI, Anthropic and Google; `openai-compatible` only where the
  vendor documents an OpenAI-compatible chat endpoint; everything else is `planned` or `no-public-api` and cannot be
  connected. The orchestrator status "Nutzbar" requires a supported integration, a connection and a routable model. Usage
  bars show ledger data or "Noch keine Nutzungsdaten"; model lists come from the registry or are labelled "Beispiele";
  pricing is non-numeric.
* **Logos:** single-colour SVGs from a pinned Simple Icons release, sanitised by `apps/web/scripts/sanitize-svg.mjs`
  (allow-list, tested), rendered via `<img>`; provenance and trademark notice in `apps/web/public/logos/SOURCES.md`.
  Brands without a vendored logo use a neutral monogram or icon tile.

## 7. Deferred (post-MVP, interfaces already in place)
Temporal workflow engine (behind `WorkflowEngine`), BullMQ/Redis queue (behind `JobQueue`), additional
model providers, Frontend/Backend/Database specialist agents, web research tool (`research.web`) and registry-based
dependency freshness checks (`dependency.scan`), image publishing and orchestrated (Kubernetes) deployments.
