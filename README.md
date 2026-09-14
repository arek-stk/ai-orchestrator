# AI Orchestrator

[![CI](https://github.com/arek-stk/ai-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/arek-stk/ai-orchestrator/actions/workflows/ci.yml)

An autonomous, auditable and cost-aware **multi-agent orchestrator** that manages many software projects at once.
You give it a goal; it understands the project, breaks the goal down, consults the specialists it actually needs,
builds the change, tests and debugs it, reviews it, and delivers it through GitHub — with hard limits, budgets and
human approval gates at every risky step.

> **Status:** active development. The orchestration core, database, model layer, agents, pipeline engine, GitHub
> adapter, sandbox and the API server (auth, RBAC, live events, workers) are implemented and tested. The web
> dashboard is next. Progress is tracked in [`docs/STATE.md`](docs/STATE.md).

## Why it is different

* **One brain, on-demand specialists.** The orchestrator is the only decision maker. Agents (planner, architect,
  builder, tester, debugger, reviewer, security, …) are activated per stage and return **schema-validated JSON** —
  no swarm of agents chatting forever.
* **Swappable models.** Models are data, providers are adapters: Anthropic, OpenAI, Google Gemini, any
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter, Mistral, DeepSeek, Groq …) and a zero-cost mock.
  Assign a model per agent role and per project, or let the **cost-aware router** pick the cheapest model that meets
  the quality floor — with cross-provider failover.
* **Bounded by design.** Stop conditions (iterations, cost, tokens, runtime, debug attempts), bounded councils,
  budgets on global / project / task / run level. When a run cannot make progress it is **blocked with an analysis**,
  not retried forever.
* **Safe delivery.** Every side effect goes through a single **tool router** (permissions → autonomy level → input
  validation → security guards → approval gates → budget → audit). Changes land on feature branches via the Git Data
  API — never on the default branch. Tests run in hardened, offline Docker containers.
* **Auditable.** Decision memory (question, options, consulted agents, evidence, confidence, cost), failure memory,
  typed domain events and a full cost ledger.

## Pipeline

```
INTAKE → ANALYZE → PLAN → DESIGN → IMPLEMENT → TEST → REVIEW → SECURITY → VERIFY → COMMIT → PUSH → PR → CI → DEPLOY → MONITOR
                                         ▲          │        │          │                                  │
                                         └── feedback ◄──────┴──────────┘              DEBUG ◄── code failure
```

* Stages are planned per task and **autonomy level** (0 Observe · 1 Suggest · 2 Execute · 3 Autonomous Development ·
  4 Autonomous Delivery); skipped stages carry a reason (a README fix needs no security audit).
* Complex tasks are **decomposed into a dependency graph** of sub-tasks; the scheduler starts only ready tasks, with
  priority, aging and fairness across projects.
* CI failures are **classified**: infrastructure problems trigger a re-run, only code failures reach the debug agent.
* Approval gates: production deploys, database migrations, destructive data changes, large architecture changes,
  secrets/permissions, critical infrastructure, high cost, low-confidence design decisions.

## Architecture

| Package | Responsibility |
|---|---|
| [`packages/core`](packages/core) | IO-free domain: contracts, scheduler, DAG, stage planner, stop conditions, budget guard, model registry & router, tool router, context builder, agent runtime & definitions, council, orchestrator pipeline engine, ports |
| [`packages/db`](packages/db) | PostgreSQL via Drizzle ORM (embedded PGlite for development), migrations, repositories, durable job queue (`FOR UPDATE SKIP LOCKED`, leases, backoff, dead-letter) |
| [`packages/integrations`](packages/integrations) | Model provider adapters (official SDKs), GitHub adapter (Octokit, Git Data API, checks, webhooks), Docker sandbox, demo responders |
| [`apps/server`](apps/server) | Fastify API, auth (GitHub OAuth + RBAC), SSE live events, scheduler and workers, demo mode |
| `apps/web` *(in progress)* | Next.js dashboard: projects, pipelines, agents, decisions, costs, approvals |

Read more: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · architecture decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Getting started

Requirements: Node.js ≥ 22 (tested with 24). No database or Docker needed for development and tests.

```bash
git clone https://github.com/arek-stk/ai-orchestrator.git
cd ai-orchestrator
npm install
npm run typecheck
npm test
```

Configuration lives in environment variables — copy [`.env.example`](.env.example) to `.env`. Without any model
provider key the system runs in **demo mode** with deterministic mock agents at zero cost.

### Run it

```bash
npm run dev:server   # API + workers on http://localhost:4000 (embedded database under .data/)
npm run dev:web      # dashboard on http://localhost:3000
```

In demo mode (no provider keys, no `GITHUB_TOKEN`) the server seeds demo projects and runs complete pipelines against
a simulated GitHub and CI. Sign in with the dev login (`ALLOW_DEV_LOGIN=true`, never available in production).
Add real providers in **Settings → Models / Providers** or via `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`; connect GitHub with `GITHUB_TOKEN` (fine-grained PAT or App token).

## Deploy with Docker

The server ships as a container image built from the repository root; `docker-compose.yml` runs it with PostgreSQL.

```bash
cp .env.example .env
# required: ORCH_ENCRYPTION_KEY (32 random bytes, base64), POSTGRES_PASSWORD, APP_ORIGIN (public https origin)
# recommended: GITHUB_CLIENT_ID/SECRET (login), GITHUB_TOKEN, provider keys, METRICS_TOKEN
docker compose up -d --build        # PostgreSQL 17 + server on http://localhost:4000
docker compose ps                   # both services report "healthy"
```

* **Image:** `apps/server/Dockerfile` bundles the server with esbuild (`npm run build -w @orch/server` →
  `apps/server/dist`, migrations included), runs as the non-root `node` user on `node:24-slim` and checks
  `/api/health`. Migrations are applied on start.
* **Without Docker:** `npm run build -w @orch/server` and `NODE_ENV=production node apps/server/dist/main.js`
  (install `apps/server/dist/package.json` dependencies when copying `dist` elsewhere).
* **Web UI:** once `apps/web/Dockerfile` exists, `docker compose --profile web up -d --build` adds the dashboard on
  port 3000 with `ORCH_SERVER_URL=http://server:4000`. Put both behind one HTTPS reverse proxy so cookies and the
  CSRF origin check see a single origin.
* **Scaling:** run additional containers with `SERVER_ROLE=api` or `SERVER_ROLE=worker` against the same
  PostgreSQL; live events fan out between instances via `LISTEN/NOTIFY`.
* **Access control:** `PROJECT_ACL=enforced` (the production default) limits operators and viewers to projects they
  are members of. Admins manage members with `PUT /api/projects/:id/members/:userId` (`{"role":"operator"}`).
* **Monitoring:** scrape `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN` (Prometheus text format);
  every response carries an `x-request-id` that also appears in the JSON logs.
* **Approvals** that stay pending longer than `APPROVAL_TTL_HOURS` (default 72) expire and block their run.

## Automation & GitHub AI

| Area | What runs |
|---|---|
| Quality gates | CI (typecheck + tests) required on `main`, CodeQL, dependency review, OpenSSF Scorecard |
| Supply chain | Dependabot security + version updates (minor/patch auto-merge after CI), SHA-pinned third-party actions, secret scanning with push protection |
| Releases | release-please: version bump, `CHANGELOG.md` and GitHub release from Conventional Commits |
| Housekeeping | Labeler by changed area, stale bot, issue forms, PR template, CODEOWNERS |
| GitHub AI | Copilot code review on every PR, Copilot coding agent setup, repository instructions for Copilot, AI issue triage and AI PR summaries |

To activate AI triage and PR summaries, add a repository secret **`COPILOT_GITHUB_TOKEN`** (a personal access token of
an account with GitHub Copilot). Without it those workflows skip with a notice.

## Security

Security is part of the architecture, not an add-on: least-privilege tool permissions per agent role, path and branch
guards, secret detection and redaction before anything reaches a model or a log, encrypted credentials, HMAC-verified
webhooks, and sandboxed execution without host shell access. See [`SECURITY.md`](SECURITY.md) for the model and how
to report vulnerabilities.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE)
