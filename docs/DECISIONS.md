# Decision Memory (Architecture Decision Records)

Append-only. Never edit an accepted decision — supersede it with a new entry that references the old id.
Format: context → decision → consequences → status.

---

## ADR-001 — Monorepo with npm workspaces, TypeScript 5.9, ESM
* **Context:** Multiple deployables (API/worker server, web UI) share domain contracts. pnpm is not
  installed on the dev machine; TypeScript 7 (native port) is too new for Next.js/Vitest tooling.
* **Decision:** npm workspaces (`packages/*`, `apps/*`), `"type": "module"`, TypeScript `~5.9`,
  `moduleResolution: "Bundler"`. Internal packages export TypeScript source (no pre-build step);
  the server runs via `tsx` in dev and is bundled for prod, Next.js uses `transpilePackages`.
* **Consequences:** One lockfile, zero build-order orchestration in dev. Type checking is per workspace
  via `tsc --noEmit`.
* **Status:** Accepted (2026-09-14)

## ADR-002 — PostgreSQL via Drizzle ORM; PGlite as embedded dev/test database
* **Context:** Spec mandates PostgreSQL. Docker daemon is not always running locally; tests must run
  without infrastructure.
* **Decision:** Drizzle ORM schema + SQL migrations. `DATABASE_URL` set → `node-postgres`.
  Unset → PGlite (real Postgres compiled to WASM) persisted under `.data/pglite`. Same schema,
  same SQL, same migrations. Tests use in-memory PGlite.
* **Consequences:** PGlite is single-process ⇒ with PGlite, API + workers must run in one process
  (`SERVER_ROLE=all`). Multi-process deployments require real PostgreSQL.
* **Status:** Accepted (2026-09-14)

## ADR-003 — Process topology: Fastify server (API + workers) + Next.js UI
* **Context:** Long-running orchestration and SSE do not fit serverless route handlers; the DB
  (PGlite in dev) must be owned by one process.
* **Decision:** `apps/server` (Fastify 5) hosts API, auth, SSE, scheduler, job workers and the
  orchestrator. `apps/web` (Next.js 16, App Router, Tailwind 4) is a pure UI that proxies `/api/*`
  to the server via rewrites (same origin for cookies/CSRF).
* **Consequences:** Clear separation; the server can be split by `SERVER_ROLE` later.
* **Status:** Accepted (2026-09-14)

## ADR-004 — Durable DB-backed job queue + checkpointed pipeline state machine (Temporal deferred)
* **Context:** Spec recommends Redis/BullMQ and Temporal. Neither is available locally; MVP must be
  fault tolerant without them.
* **Decision:** `jobs` table with `FOR UPDATE SKIP LOCKED` claiming, lease (`locked_until`), retries
  with exponential backoff, dedupe keys. Pipeline runs persist stage state after each step; one step =
  one job. `JobQueue` and `WorkflowEngine` are core ports so BullMQ/Temporal adapters can replace them.
* **Consequences:** Crash recovery via lease expiry. Throughput is bounded by Postgres, sufficient for
  orchestration workloads (low-frequency, long-running steps).
* **Status:** Accepted (2026-09-14)

## ADR-005 — Multi-provider, swappable model layer (models are data, providers are adapters)
* **Context:** No hard coupling to one vendor. User requirement (2026-09-14): "es soll auch mit mehreren
  Modellen austauschbar sein" — models and providers must be interchangeable at runtime.
* **Decision:**
  * **`ModelProvider` port** in core: `generateStructured({schema, system, messages, maxOutputTokens,
    reasoning}) → {data, usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, modelId,
    stopReason}`. Providers only translate; routing, budgets and validation stay in core.
  * **Adapters** (`packages/integrations/src/providers`): `anthropic` (official `@anthropic-ai/sdk`),
    `openai` (official `openai` SDK), `google` (official `@google/genai` SDK), `openai-compatible`
    (OpenAI SDK with custom `baseURL` — Ollama, LM Studio, vLLM, OpenRouter, Mistral, DeepSeek, Groq…),
    `mock` (deterministic, schema-valid, zero cost — demo mode and tests). Each adapter verifies SDK
    usage against the installed SDK typings, never guessed.
  * **Models are data:** `model_configs` table (provider, model id, display name, context window,
    max output, $/MTok in/out/cache, latency class, coding/reasoning scores, capabilities
    `structuredOutput|vision|tools|reasoning`, enabled flag). Seeded with defaults, editable in the UI
    (Settings → Models) without redeploy. Provider credentials in `provider_configs` (encrypted).
  * **Selection precedence:** explicit per-run pin → project override per agent role → global
    override per agent role → `ModelRouter` automatic choice by tier/requirements/cost.
  * **Fallback chains:** on provider outage/429/5xx the router picks the next eligible model,
    preferring a different provider (cross-provider failover).
  * **Seed defaults:** Anthropic `claude-haiku-4-5` (fast), `claude-sonnet-5` (balanced),
    `claude-opus-5` (reasoning / final decision); other providers seeded **disabled** until a
    credential is configured; `mock` enabled only in demo mode.
* **Consequences:** Adding a provider = one adapter + rows in `model_configs`. Swapping a model for an
  agent role is a settings change. Cost tracking stays uniform because pricing lives in the registry.
* **Status:** Accepted (2026-09-14)

## ADR-006 — No host execution; code changes via GitHub Git Data API; tests in Docker sandbox or CI
* **Context:** Agents must never run arbitrary commands with host rights; never write to `main`.
* **Decision:** Build/Debug agents emit structured file edits (path + full new content + rationale).
  The Tool Router validates paths and applies them as a commit on an `orchestrator/<task>` feature
  branch using the Git Data API (blobs → tree → commit → ref). Tests run either in the Docker sandbox
  (`--network none --read-only --cap-drop ALL`, allow-listed commands from the project profile) or,
  when no sandbox is available, verification is delegated to CI (GitHub Actions check runs).
* **Consequences:** No local clone needed for the MVP; the default branch is never a write target.
* **Status:** Accepted (2026-09-14)

## ADR-007 — Authentication: GitHub OAuth + DB sessions + RBAC
* **Decision:** GitHub OAuth web flow with `state` parameter; session token = 32 random bytes, only
  its SHA-256 stored; httpOnly/SameSite=Lax cookie; roles `owner|admin|operator|viewer`; first user
  becomes owner. Dev login gated by `ALLOW_DEV_LOGIN=true` and `NODE_ENV!=production`.
* **Status:** Accepted (2026-09-14)

## ADR-008 — Event-driven: persisted events + in-process bus + SSE
* **Decision:** Every domain event is inserted into `events` and published on a typed in-process bus.
  SSE endpoint streams events (with `Last-Event-ID` replay from the table). Multi-instance fan-out via
  Postgres LISTEN/NOTIFY is deferred.
* **Status:** Accepted (2026-09-14)

## ADR-009 — Secrets encrypted at rest (AES-256-GCM), never in model context
* **Decision:** `ORCH_ENCRYPTION_KEY` (32 bytes, base64) encrypts tokens and provider keys stored in DB.
  Context builder and log redactor strip secret-looking values (`ghp_`, `gho_`, `sk-`, `sk-ant-`,
  `AIza`, private keys, `.env` files).
* **Status:** Accepted (2026-09-14)

## ADR-010 — Structured agent outputs validated by zod; invalid output = failed attempt
* **Decision:** Each agent definition owns a zod schema. Providers must return data conforming to it;
  the runtime re-validates. Validation failure consumes an attempt and is recorded, never coerced.
* **Status:** Accepted (2026-09-14)

## ADR-011 — TypeScript 7 for packages and server; the web app keeps TypeScript 5.9 (supersedes the TS part of ADR-001)
* **Context:** The repository owner merged the Dependabot update to `typescript@7` (native port). Typecheck and all
  tests of `packages/*` and `apps/server` pass with it. TypeScript 7 no longer ships the classic JavaScript compiler
  API (`typescript` exports only a version module and `unstable/*` APIs), which Next.js uses during `next build`.
* **Decision:** Root toolchain uses `typescript@~7`. `apps/web` declares its own `typescript@~5.9` devDependency so
  Next.js resolves the classic API locally. Dependabot ignores further TypeScript and `@types/node` major updates
  until they are evaluated explicitly.
* **Consequences:** Two TypeScript majors in one repository; `npm run typecheck` runs each workspace with the version
  it resolves. Revisit when Next.js supports TypeScript 7.
* **Status:** Accepted (2026-09-14)

## ADR-012 — Repository automation and GitHub AI
* **Context:** The repository is public; the owner asked for all available bots, automation and GitHub AI.
* **Decision:**
  * Required CI on `main` (branch protection, conversation resolution, no force pushes); CodeQL (`security-extended`),
    dependency review, OpenSSF Scorecard, secret scanning with push protection, Dependabot alerts and security updates.
  * Dependabot grouped weekly updates with auto-merge for minor/patch after CI; third-party actions pinned to SHAs.
  * release-please for versioning, changelog and GitHub releases from Conventional Commits.
  * Copilot: repository instructions (`.github/copilot-instructions.md`, `AGENTS.md`), automatic Copilot code review
    via ruleset, `copilot-setup-steps` for the coding agent.
  * AI workflows (issue triage, PR summaries) through `actions/ai-inference` + Copilot CLI with a
    `COPILOT_GITHUB_TOKEN` secret. Untrusted text reaches the model only via files, the model gets no tools, labels
    pass an allow-list, jobs run with minimal permissions and skip when the secret is absent.
* **Consequences:** Every change lands through a pull request with green CI; AI output is advisory and never gates or
  merges anything.
* **Status:** Accepted (2026-09-14)
* **Addendum (2026-09-14) — milestones drive releases:**
  * Roadmap milestones are named `vX.Y — <theme>`; `Backlog — proposed` is never released. When a `vX.Y` milestone
    has no open and at least one closed item, `milestone-release.yml` targets `X.Y.0`: it squash-auto-merges the
    release-please PR if it already has that version, otherwise it opens a bot PR with an empty `Release-As: X.Y.0`
    commit first. Required checks and conversation resolution still gate every merge; branch protection is never
    bypassed. After the release is published it appends the milestone link to the notes, comments on the release PR
    and closes the milestone. Only the lowest open `vX.Y` milestone is acted on.
  * Bot PRs get CI without a personal token: their `pull_request` runs wait for approval, so the workflow dispatches
    `ci.yml` (`workflow_dispatch` is exempt from the GITHUB_TOKEN trigger rule) once per head commit, and dispatches
    release-please when a bot merge left the default branch head unprocessed. A PAT or GitHub App token was rejected
    as a standing credential with write access.
  * Safety: decisions live in the pure, unit-tested `.github/scripts/milestone-release/logic.mjs`; only bot-authored
    PRs from this repository are auto-merged; auto-merge enabled by a human is never withdrawn; a merged or closed
    Release-As PR is never recreated. Pause with the repository variable `AUTO_RELEASE=false` or the `release:hold`
    label on the release PR. PRs get a milestone only from a `milestone:vX.Y` label or a closing reference to an issue
    in that milestone.

## ADR-020 — Production build: esbuild bundle, container image and compose stack
* **Context:** ADR-001 bundles the server for production, but no bundle, image or deployment description existed.
  Internal packages export TypeScript source; PGlite loads WASM files relative to its module.
* **Decision:** `apps/server/scripts/build.mjs` bundles `src/main.ts` with esbuild into `apps/server/dist/main.js`
  (ESM, node24, `createRequire` banner). `@electric-sql/pglite` stays external and is listed in a generated
  `dist/package.json`; `pg-native` is external (optional). Drizzle migrations are copied to `dist/drizzle`; the
  container uses `MIGRATIONS_DIR` or auto-detects a `drizzle` folder next to the bundle before falling back to
  `@orch/db`'s folder. `apps/server/Dockerfile` (context: repository root) is a two-stage `node:24-slim` build running
  as the non-root `node` user with an HTTP healthcheck on `/api/health`. `docker-compose.yml` runs PostgreSQL 17
  (named volume, `pg_isready`) and the server (secrets via `.env` and required `${VAR:?}` interpolation); the web UI is
  a `web` profile building `apps/web/Dockerfile` once that exists. CI builds the image on pull requests without
  pushing.
* **Consequences:** One self-contained artefact per release; no registry publishing yet. Adding a dependency that
  loads files relative to its module requires listing it in `RUNTIME_DEPENDENCIES`.
* **Status:** Accepted (2026-09-14)

## ADR-021 — Metrics endpoint and structured request logging
* **Context:** Operations (spec §21) needs queue depth, run states, spend and HTTP health without adding services.
* **Decision:** `GET /api/metrics` renders Prometheus text format from a small dependency-free registry (bounded
  series per metric). Access: a bearer token equal to `METRICS_TOKEN` (compared as SHA-256 digests in constant time)
  or an admin session; nothing else. Gauges are collected from the database on scrape (runs by status, jobs by status,
  active agent runs, pending approvals, cost/tokens/calls today); counters and histograms are process-local (HTTP
  requests and durations labelled with the route template, worker job outcomes, approvals expired, fan-out results).
  Requests carry an id (valid inbound `x-request-id` or a UUID) that is logged as `reqId` and echoed in the response;
  pino redacts credential headers and secret-like fields, and the error serializer runs `redactSecrets`.
* **Consequences:** Scrape every instance (API and worker processes keep their own counters). A worker-only process
  has no HTTP listener, so its counters are not exposed.
* **Status:** Accepted (2026-09-14)

## ADR-022 — Per-project access control on `project_members` (refines ADR-007)
* **Context:** Security review: roles are global, so every operator/viewer can read and act on every project.
* **Decision:** `PROJECT_ACL=enforced|off` (default `enforced` when `NODE_ENV=production`, `off` otherwise). Owners and
  admins see every project. Operators and viewers see only projects they are members of; the effective project role
  is the lower of the global role and the membership role (`operator | viewer`). Every project-scoped route asserts
  access (reads of foreign resources answer 404, insufficient project role 403); list endpoints, costs, dashboard and
  event history merge per-project queries over the user's memberships (bounded to 500); the SSE stream filters events
  and refreshes memberships every heartbeat; events without a project are hidden from restricted users. Admins manage
  memberships via `/api/projects/:id/members` (audited). Global role checks from ADR-007 still apply first.
* **Consequences:** Instances can host several teams with separated projects. Global settings, models, providers and
  queue depth remain instance-wide and are visible according to global roles only.
* **Status:** Accepted (2026-09-14)

## ADR-023 — Approval expiry
* **Context:** Pending approvals never expired, parking runs in `WAITING` indefinitely.
* **Decision:** `APPROVAL_TTL_HOURS` (default 72, `0` disables). The scheduler tick expires up to 100 of the oldest
  pending approvals older than the TTL (`status = expired`, `decided_by = system`), then the orchestrator blocks the
  waiting run with "Approval for <action> expired without a decision". `approval.decided` carries status `expired`;
  the audit log records `approval.expired`. Late decisions on finished or cancelled runs are ignored.
* **Consequences:** Stale gates surface as blocked tasks that can be retried, which requests a fresh approval.
* **Status:** Accepted (2026-09-14)

## ADR-024 — Multi-instance event fan-out with PostgreSQL LISTEN/NOTIFY (completes ADR-008)
* **Context:** With `SERVER_ROLE=api` and `worker` processes, SSE clients of an API instance never saw events emitted
  by workers until they reconnected.
* **Decision:** On PostgreSQL (`EVENT_FANOUT=auto`), the event recorder persists the event, publishes it locally, marks
  its id as seen and sends `NOTIFY orch_events '<id>'`. Every instance listens on a dedicated connection, validates the
  payload, deduplicates ids (bounded set of 10 000), loads the row and publishes it on its local bus. After a lost
  listener connection it reconnects with backoff and replays events newer than the highest id it has seen (bounded
  500). PGlite (single process) keeps the in-process bus only. The relay logic is independent of the driver and tested
  with fakes.
* **Consequences:** Notification payloads never contain event data; ordering across instances is best effort (SSE
  clients still replay by id). A failed NOTIFY is logged; the event remains persisted.
* **Status:** Accepted (2026-09-14)

## ADR-030 — Collaboration and planning: Project Room, MCP access for external AIs, leases, Kanban and roadmap
* **Context:** The owner wants colleagues and friends — and their own AI assistants (Claude Code, Copilot, Cursor…) —
  to work on the same repository together with the orchestrator, talk in a shared chat, and plan work on a Kanban
  board and roadmap. Spec §35 forbids free-running agent-to-agent chatter; the orchestrator must stay the only
  decision maker.
* **Decision:**
  * **One task system, many views.** Kanban board, roadmap and milestones are views and planning tools over the
    existing tasks (status, priority, DAG, parent/child). Tasks gain assignee (orchestrator | user | external AI),
    milestone, board position and estimate.
  * **Project Room** per project: persisted, typed messages with an intent (message, claim, release, handoff,
    question, objection, status, decision request) and references to tasks, runs, decisions and paths; delivered live
    over the existing SSE stream. `@orchestrator` commands create tasks, answer status questions and handle approvals
    for authorised users.
  * **External AIs join through an MCP server** exposed by the orchestrator, each with its own identity, owner,
    scopes and project memberships (per-project ACL). Tools: read tasks/context/decisions, claim/release tasks,
    report progress, post messages, request review, raise objections.
  * **Leases** on tasks and path globs prevent the orchestrator and humans/external AIs from changing the same code
    concurrently; the scheduler skips tasks owned by others and pipelines wait on overlapping leases.
  * **Bounded AI-to-AI interaction:** objections become council inputs with a round limit; the orchestrator decides and
    records the decision. Chat content from external AIs is untrusted data: it never triggers tools or approvals.
* **Consequences:** New tables (messages, AI identities, leases, milestones) and task columns; migrations follow the
  current schema owner's `0001`. Implementation plan: `docs/plans/project-room.md`.
* **Status:** Accepted (2026-09-14), implementation after the running module PRs are merged

## ADR-013 — Project Health Scan: deterministic score, ROI-ranked proposals, guarded auto-acceptance
* **Context:** Spec §14 asks for autonomous product improvement without "unrequested large changes". Model output is
  not reproducible, and an improvement loop must not flood projects with work or spend unbounded budget.
* **Decision:**
  * The health score (0–100) is computed **only from deterministic signals** (repository index, dependency manifests,
    failure memory, recent run outcomes, blocked tasks) as capped penalties per component; the breakdown and signals
    are persisted with each scan in `health_scans`.
  * Proposals come from heuristics plus at most one `health_scan` and one `devops_review` agent call per scan, under a
    per-scan cost cap (default $1) enforced through the `AgentRuntime` run budget. A budget pause degrades to a
    heuristics-only scan. Agent proposals must cite evidence; affected paths not in the index are dropped.
  * Priority = log-scaled ROI `impact × 10 / (effort × risk)`; improvement tasks are capped at priority 5 so they never
    outrank requested work. Proposals are deduplicated by fingerprint (category + normalised title); decisions are
    sticky, so a dismissed improvement never returns.
  * A proposal becomes a `BACKLOG` task only when a human accepts it, or automatically when autonomy level ≥ 3 **and**
    risk = low **and** effort = small, limited to 3 per scan and 5 open auto-created tasks per project. Security
    findings that need secret rotation are rated medium risk and never auto-accepted.
  * One scan = one durable `project.health_scan` job (dedupe per project); scheduled daily for projects at level ≥ 1
    with a repository, manual only at level 0.
* **Consequences:** Scores are explainable and comparable across scans; the improvement loop is bounded in cost and
  work in progress. Registry lookups for outdated versions need a network-enabled `dependency.scan` tool (not yet built).
* **Status:** Accepted (2026-09-14)

## ADR-014 — Agent output cache and file summaries (spec §31)
* **Context:** Analysis, summaries and health scans are repeated with identical inputs; `cache_entries` and
  `repo_files.summary` existed but were unused. Caching code-changing agents would silently reuse stale results.
* **Decision:**
  * Definitions opt in with `cacheTtlMs`. Key = sha256(project, definition key, routed model id, system prompt, rendered
    prompt), so any change in context, model or prompt is a miss and nothing is shared across projects. Hits are
    re-validated against schema and verify checks. `NON_CACHEABLE_AGENT_KEYS` hard-excludes plan, design, build,
    test, debug, review, security, synthesis, blocker analysis, documentation, release readiness and research.
  * Enabled for `analyze` (24 h), `health_scan` and `devops_review` (12 h), `file_summary` (30 d). A hit is served
    before the budget gate, recorded as an agent run with `cache_hit` and as a ledger row with `cost_usd = 0` and
    `saved_usd` = original cost; `agent.completed` carries `cached`. Usage statistics expose `cacheHits` and `savedUsd`.
  * File summaries: fast-tier `file_summary` agent, batches of ≤ 6 files ≥ 2 KB, ≤ 1–2 batches per call site, ordered
    by task relevance or importer count. Stored with `summary_sha = blob sha` and only if the sha still matches; the
    repository index returns a summary only while `summary_sha = sha`.
* **Consequences:** Repeated scans and analyses cost nothing and the savings are visible in cost data. Cache writes are
  best effort and never fail a successful agent call.
* **Status:** Accepted (2026-09-14)

## ADR-015 — Specialists: documentation, release readiness, DevOps, research (spec §5)
* **Context:** Roles existed without definitions. The spec requires more specialists but "no unnecessary agents".
* **Decision:**
  * **Documentation** implements `docs` tasks instead of the build agent and writes only through the new `docs.write`
    tool, which accepts documentation paths only (Markdown/RST, `docs/`, README/CHANGELOG/…, OpenAPI files). Its verify
    check rejects code paths as well.
  * **Release readiness** runs in DEPLOY before the merge/dispatch and before the production deploy approval:
    deterministic checks (tests, security, migrations, changelog, version, CI) first — a failing check blocks without
    a model call — then the release agent; `not_ready` blocks the run with named blockers. The verdict is attached to
    the approval and reused after it.
  * **DevOps** runs only inside a health scan and only when CI or container files exist; its suggestions become
    proposals, never direct changes.
  * **Research** runs only on an explicit API request (`project.research` job), never in the default pipeline. It has
    no tools (no web access yet), and its result is stored as memory; PLAN includes research linked to its task.
* **Consequences:** Four specialists with least-privilege tools and deterministic checks; the default pipeline gains
  at most one model call (release readiness) and only for projects that deploy.
* **Status:** Accepted (2026-09-14)

## ADR-016 — Orchestration intelligence API lives in its own route module
* **Context:** Several contributors change `apps/server` in parallel; `routes.ts` is a merge hotspot.
* **Decision:** Health scans, proposals and research are served from `apps/server/src/routes-health.ts`, registered
  with one line in `app.ts`. Composition lives in `apps/server/src/intelligence.ts`; workers claim its job types.
  Mutations require the operator role and write audit entries, like every other mutating route, and every
  project-scoped read or action goes through the per-project access control of ADR-022.
* **Consequences:** Feature areas can grow without touching the core route file.
* **Status:** Accepted (2026-09-14)
