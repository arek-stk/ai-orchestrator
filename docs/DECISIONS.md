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
