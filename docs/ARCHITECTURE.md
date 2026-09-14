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
Architecture, Security. Each definition declares role, default capability tier, output schema,
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

## 7. Deferred (post-MVP, interfaces already in place)
Temporal workflow engine (behind `WorkflowEngine`), BullMQ/Redis queue (behind `JobQueue`), additional
model providers, Research/Documentation/DevOps/Release/Frontend/Backend/Database agents, autonomous
product-improvement scans, image publishing and orchestrated (Kubernetes) deployments.
