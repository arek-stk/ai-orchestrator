# Build State

Persistent progress tracker. Updated after every module (build → tests → review → fix → retest).
Architecture: `docs/ARCHITECTURE.md` · Decisions: `docs/DECISIONS.md`.

| # | Module | Status | Verification |
|---|---|---|---|
| 1 | Architecture + Decision Memory | ✅ done | ADR-001…010 |
| 2 | Core domain: enums, task/project contracts, DAG, scheduler, stage planner, stop conditions, budget guard, security helpers, failure fingerprint, CI classifier, approval policy, events | ✅ done | `tsc` clean · 70 tests |
| 3 | Core contracts: runs, records, model types, ports | ✅ done | `tsc` clean |
| 4 | Database: Drizzle schema (20 tables), PGlite/pg client, migration `0000_init`, repositories, durable job queue (SKIP LOCKED, leases, backoff, dead-letter, dedupe) | ✅ done | 11 tests on in-memory PGlite |
| 5 | Model layer: registry + cost accounting, cost-aware router (quality floors, pins/overrides, cross-provider fallback chain), adapters for Anthropic (incl. server-side refusal fallback on Opus 5), OpenAI, Google, OpenAI-compatible, Mock | ✅ done | 10 router tests · adapters tested against local fake APIs through the real SDKs |
| 6 | Tool router (permissions → autonomy → validation → security → approval → budget → audit) + context builder (ranking, neighbours, packing, redaction) | ✅ done | 12 tests |
| 7 | Agent runtime (budget gate, routing, fallback, verification, spend + events), 10 agent definitions, LlmAgent contract, bounded council, demo responders | ✅ done | 20 tests · total 135 tests green |
| 8 | Orchestrator pipeline engine: durable step state machine, all 15 stage handlers + DEBUG, bounded repair loops, approval gates (change-set detection, high cost, architecture, production deploy), CI infra/code classification, task decomposition into a DAG, decision reuse, analysis cache per commit, blocker analysis, stalled-run recovery, repo indexer, GitHub/Sandbox ports, in-memory GitHub + stores | ✅ done | 11 end-to-end pipeline scenarios · review findings of modules 1–4 fixed |
| 9 | GitHub integration: Octokit adapter (Git Data API commits, PR upsert, checks + workflow runs aggregation with failing-job logs, re-runs, merge, workflow dispatch, rate-limit → wait), HMAC webhook verification + event parsing; Docker sandbox (hardened `docker run`, snapshot + change set workspace, infra vs command failures, timeouts) | ✅ done | adapter tested against a local fake GitHub API; sandbox with fake exec |
| — | Public repository hygiene: README, MIT license, SECURITY.md, CONTRIBUTING.md, GitHub Actions CI | ✅ done | — |
| 10 | Server (`apps/server`): env config, AES-GCM secrets, composition root (PGlite/Postgres, provider credentials from env + encrypted settings, demo mode with mock agents and simulated GitHub/CI), GitHub OAuth + dev login, DB sessions (hashed tokens), RBAC, CSRF origin check, rate limits, security headers, REST API (dashboard, projects, tasks, runs, agents, decisions, approvals, memory, costs, models, providers, settings, users, audit), SSE live events with replay, HMAC GitHub webhooks waking CI-waiting runs, worker pool with leases/heartbeat + scheduler tick, demo seed | ✅ done | 9 API tests incl. full pipeline through workers · 175 tests total |
| — | Repository automation (ADR-012): branch protection, CodeQL, dependency review, Scorecard, secret scanning + push protection, Dependabot with auto-merge, release-please, labeler, stale, issue/PR templates, CODEOWNERS | ✅ done | all checks green on PRs #2, #5 |
| — | GitHub AI (ADR-012): Copilot instructions + `AGENTS.md`, Copilot code review ruleset, coding-agent setup steps, AI issue triage and PR summaries via GitHub Copilot | ✅ done | workflows green; AI jobs need `COPILOT_GITHUB_TOKEN` |
| 11 | Web dashboard (Next.js 16, React 19, Tailwind 4): dashboard, projects with tabs, runs, agents, approvals, decisions, costs, settings, live events | 🚧 in progress | — |
| 12 | Security review of server, adapters and AI workflows: admin-only project profile (sandbox commands), sandbox installs only via restricted egress network, Secure cookies on HTTPS, deployment assumptions in SECURITY.md; earlier reviews fixed billing of failed attempts, git option injection, NTFS streams, destructive SQL detection, council prompt injection, dev-key race (CodeQL) | ✅ done | PR #8 · regression tests · CodeQL clean |
| 12a | Per-project access control (ADR-022): `PROJECT_ACL`, membership API, enforcement on projects, tasks, runs, agent runs, decisions, approvals, memory, costs, dashboard, event history and SSE | ✅ done | `acl.test.ts`: cross-project denial for 13 reads and 10 mutations, role capping, membership audit |
| 12b | Approval expiry (ADR-023): TTL, blocked run with reason, event + audit, no reopening of finished runs | ✅ done | `approval-expiry.test.ts` (4 tests) |
| 14 | Deployment (ADR-020): esbuild bundle with migrations, multi-stage Dockerfile (non-root, healthcheck), docker compose with PostgreSQL, CI image build on PRs | ✅ done | bundle started locally against PGlite; `docker compose config` valid; image build runs in CI (no local Docker daemon) |
| 15 | Observability (ADR-021): `/api/metrics` (Prometheus), request ids, log redaction, worker/HTTP counters | ✅ done | `metrics.test.ts` |
| 16 | Multi-instance events (ADR-024): LISTEN/NOTIFY fan-out with dedupe, reconnect and gap replay | ✅ done | `event-fanout.test.ts` with fakes; not yet exercised against a real PostgreSQL |
| 13 | Optimisation: caching, decision reuse | ⏳ | — |

## Known constraints on the dev machine
* Docker daemon not running → sandbox defaults to `SANDBOX=none` (verification delegated to CI).
* No local PostgreSQL/Redis → embedded PGlite (ADR-002), DB-backed queue (ADR-004).
