# Plan: platform, operations and security hardening

Scope of the "platform-operations" work stream (spec §21 observability, §24 deployment, security review
follow-ups). Constraints: no schema changes, no migrations, nothing inside `apps/web`; new code lives in new
server files registered with one line each. ADRs are numbered from ADR-020.

## 1. Gap analysis

| Area | Today | Gap |
|---|---|---|
| Deployment | `tsx src/main.ts` only; migrations resolved relative to `packages/db/src` | No production bundle, no image, no compose stack, no CI image build |
| Observability | pino request logs (cookie/authorization redacted), `/api/health` | No metrics endpoint, no request ids echoed to clients, provider keys/tokens in bodies not redacted |
| Access control | Global roles only; `project_members` table unused; SECURITY.md says "one trusted organisation" | Operators/viewers see and act on every project, events stream leaks all projects |
| Approvals | `pending` forever; `expired` exists in the schema but is never set | Runs park in `WAITING` indefinitely, the project stays `WAITING` |
| Events | In-process bus (ADR-008); multi-instance fan-out deferred | With `SERVER_ROLE=api` + `worker` on PostgreSQL, SSE clients of the API never see worker events live |

## 2. Design

### 2.1 Deployment (ADR-020)
* `apps/server/scripts/build.mjs`: esbuild bundles `src/main.ts` (and the internal `@orch/*` TypeScript sources)
  into `dist/main.js` (ESM, node24, `createRequire` banner for CJS dependencies, source maps).
  `@electric-sql/pglite` stays external (it loads its WASM/data files relative to its module) and `pg-native` is
  an optional peer. The script writes `dist/package.json` pinning the external dependencies at the installed
  versions and copies `packages/db/drizzle` to `dist/drizzle`.
* Migrations: `MIGRATIONS_DIR` env overrides; otherwise a `drizzle` folder next to the running module is used when
  it exists (bundle), else the `@orch/db` default (dev/tests).
* `apps/server/Dockerfile` (context = repo root): `node:24-slim` build stage (`npm ci`, build, install externals
  into `dist`), runtime stage as user `node`, `HOST=0.0.0.0`, `DATA_DIR=/data`, `HEALTHCHECK` via `node -e fetch`.
* `docker-compose.yml`: `postgres:17` (named volume, `pg_isready` healthcheck), `server` (depends on healthy
  postgres, `DATABASE_URL`, secrets from `.env` + required `${VAR:?}` interpolation), `web` under the `web` profile
  building `apps/web/Dockerfile` (to be added by the web work stream). `.dockerignore`.
* CI: job `docker` (pull requests only) runs `docker build -f apps/server/Dockerfile .` without pushing.

### 2.2 Observability (ADR-021)
* `metrics.ts`: dependency-free Prometheus registry (counter, gauge, histogram; label escaping; bounded label sets).
* `routes-metrics.ts`: `GET /api/metrics`. Auth: `Authorization: Bearer $METRICS_TOKEN` (timing-safe) when the token
  is configured, otherwise an admin session. Collected on scrape: runs by status, jobs by status, active agent runs,
  pending approvals, cost/tokens/calls today. Recorded continuously: HTTP requests and durations by
  method + route template + status (Fastify `onResponse`), worker job outcomes, approvals expired, fan-out events.
* `logging.ts`: request id from a valid inbound `x-request-id` or a UUID, echoed as a response header; pino redact
  paths for cookies, authorization, webhook signatures, `set-cookie`, and secret-like body fields (`apiKey`, `token`,
  `password`, `secret`, `clientSecret`, `accessToken`).

### 2.3 Per-project access control (ADR-022)
* `PROJECT_ACL=enforced|off`; default `enforced` when `NODE_ENV=production`, otherwise `off`.
* Owners/admins: all projects. Operators/viewers: only projects with a `project_members` row. Effective project
  role = the lower of global role and membership role (membership roles `operator | viewer`).
* `acl.ts` exposes `ProjectAcl` (visible project ids per request, `assert(request, projectId, minRole)`, scoped list
  helper that merges per-project queries for restricted users, bounded to 500 memberships).
  Denied reads answer 404 (no existence oracle); a visible project with an insufficient membership role answers 403.
* Enforced on: dashboard, projects (list/get/patch/pause/resume/memory), tasks, runs, agent runs, decisions,
  approvals, costs, events history and the SSE stream (filter re-evaluated on every heartbeat).
* `routes-members.ts` (admin): list/upsert/delete members; audited. Repository added to `admin-repositories.ts`.

### 2.4 Approval expiry (ADR-023)
* `APPROVAL_TTL_HOURS` (default 72, `0` disables). `approval-expiry.ts` runs in the scheduler tick: pending approvals
  older than the TTL (bounded batch of 100) are set to `expired` via `approvals.decide(..., 'expired', 'system')`,
  then `orchestrator.onApprovalDecided` blocks the run with "approval for <action> expired after <n>h without a
  decision". Emits `approval.decided` with status `expired`; audit `approval.expired`; metric counter.
* Core change is minimal: the approval decision type accepts `expired` and the block reason distinguishes it.

### 2.5 Multi-instance events (ADR-024, completes ADR-008)
* `event-fanout.ts`: `EventFanout` interface (`announce(event)`, `start()`, `close()`), `LocalEventFanout` (PGlite,
  no-op) and `PgNotifyEventFanout` (PostgreSQL). The recorder persists, publishes locally, marks the id as seen and
  `NOTIFY orch_events '<id>'`. Listeners validate the payload, dedupe by id (bounded LRU of 10 000 ids), load the row
  and publish on the local bus. After a listener reconnect, missed ids are replayed from the table (bounded 500).
* `packages/db/src/client.ts` gains `listen/notify` on the PostgreSQL handle (dedicated client from the pool).
* The relay logic (parse, dedupe, load, publish, gap replay) is a pure class tested with fakes.

## 3. Config / env changes
`PROJECT_ACL`, `METRICS_TOKEN`, `APPROVAL_TTL_HOURS`, `MIGRATIONS_DIR`, `EVENT_FANOUT=auto|off` (auto → NOTIFY on
PostgreSQL). Docker: `POSTGRES_PASSWORD`. All added to `.env.example`.

## 4. Test plan
* `acl.test.ts`: two projects, operator member of one, viewer member with viewer membership; cross-project reads
  (project, tasks, task, runs, run, agents, decisions, approvals, memory, costs, events, dashboard) are filtered or
  404; mutations (patch, pause, create task, start/cancel task) denied; membership role caps operator to viewer;
  members endpoints admin-only and audited; `PROJECT_ACL=off` keeps today's behaviour; SSE filter unit test.
* `metrics.test.ts`: exposition format and escaping; endpoint auth (401 without, 403 non-admin, token works,
  wrong token fails); HTTP counters by route template; request id header echo; log redaction via captured stream.
* `approval-expiry.test.ts`: expired approval blocks the run with a clear reason, emits event and audit; fresh
  approvals untouched; TTL 0 disables.
* `event-fanout.test.ts`: dedupe own and repeated ids, invalid payloads ignored, loader misses tolerated,
  gap replay after reconnect, LRU bound.
* Build: `npm run build -w @orch/server`, then start `dist/main.js` on port 4300 against PGlite, `GET /api/health`.
* `docker compose config` for static validation (daemon unavailable locally; CI builds the image).

## 5. Non-goals
Kubernetes manifests, image publishing/registries, OpenTelemetry tracing, per-project roles for admins, web UI for
memberships (the web work stream can consume the API), schema changes (e.g. `expires_at` column), Redis.
