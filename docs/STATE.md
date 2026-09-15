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
| — | Milestone releases (ADR-012 addendum): roadmap milestones `v0.4`–`v0.6` + backlog, `milestone-release.yml` with three modes: safe by default (ready/retarget comments, release notes, milestone close; no PRs, no CI dispatch, no auto-merge), `AUTO_RELEASE_PREPARE=true` (Release-As PRs, CI dispatch for bot PRs) and `AUTO_RELEASE_MERGE=true` (plus squash auto-merge); PR milestone assignment from labels/closing references, fail-closed trusted-actor event gate, `AUTO_RELEASE` / `release:hold` pause | ⏸️ on hold (owner decision: CI dispatch for bot PRs, bot merges without required reviews) | `logic.test.ts` unit tests; end-to-end run only after merge |
| — | GitHub AI (ADR-012): Copilot instructions + `AGENTS.md`, Copilot code review ruleset, coding-agent setup steps, AI issue triage and PR summaries via GitHub Copilot | ✅ done | workflows green; AI jobs need `COPILOT_GITHUB_TOKEN` |
| — | Repo Guardian (ADR-012 addendum): scheduled health check of CI on `main`, code scanning/Dependabot/secret scanning alerts, open PRs (checks, conflicts, review threads, inactivity), branch protection, docs consistency (STATE rows, ADR numbers, plan references, relative links), stale branches and Dependabot PRs; one self-closing "Repo Guardian report" issue | ✅ done | 35 vitest tests for evaluation, escaping, degraded runs, change detection and link checker · dry run against the live repository · secret scanning and full branch protection need the optional `REPO_GUARDIAN_TOKEN` |
| 11 | Web dashboard (Next.js 16, React 19, Tailwind 4): dashboard, projects with tabs, runs, agents, approvals, decisions, costs, settings, live events; screenshot-based design QA (light/dark), same-origin login redirect | ✅ done | PR #11 · typecheck + production build · CodeQL clean · no UI tests yet |
| 12 | Security review of server, adapters and AI workflows: admin-only project profile (sandbox commands), sandbox installs only via restricted egress network, Secure cookies on HTTPS, deployment assumptions in SECURITY.md; earlier reviews fixed billing of failed attempts, git option injection, NTFS streams, destructive SQL detection, council prompt injection, dev-key race (CodeQL) | ✅ done | PR #8 · regression tests · CodeQL clean |
| 12a | Per-project access control (ADR-022): `PROJECT_ACL`, membership API, enforcement on projects, tasks, runs, agent runs, decisions, approvals, memory, costs, dashboard, event history and SSE | ✅ done | `acl.test.ts`: cross-project denial for 13 reads and 10 mutations, role capping, membership audit |
| 12b | Approval expiry (ADR-023): TTL, blocked run with reason, event + audit, no reopening of finished runs | ✅ done | `approval-expiry.test.ts` (4 tests) |
| 14 | Deployment (ADR-020): esbuild bundle with migrations, multi-stage Dockerfile (non-root, healthcheck), docker compose with PostgreSQL, CI image build on PRs | ✅ done | bundle started locally against PGlite; `docker compose config` valid; image build runs in CI (no local Docker daemon) |
| 15 | Observability (ADR-021): `/api/metrics` (Prometheus), request ids, log redaction, worker/HTTP counters | ✅ done | `metrics.test.ts` |
| 16 | Multi-instance events (ADR-024): LISTEN/NOTIFY fan-out with dedupe, reconnect and gap replay | ✅ done | `event-fanout.test.ts` with fakes; not yet exercised against a real PostgreSQL |
| 12c | CodeQL high alerts #24–#27: linear-time slugs (`dashSlug`) and ```` ```json ```` fence unwrapping instead of backtracking regexes; provider adapter cache compares credentials by id instead of a SHA-256 of the API key (in-memory only, nothing persisted) | ✅ done | legacy-regex equivalence tests · 50k-char hostile inputs < 1 s · resolver rotation test |
| 13 | Optimisation: caching, decision reuse | 🚧 in progress | agent output cache + file summaries done (row 19) |
| 17 | Autonomous product improvement (ADR-013): Project Health Scan (deterministic signals + score, heuristic, scan-agent and DevOps proposals, ROI priority, fingerprint dedupe, guarded auto-acceptance into BACKLOG tasks, daily scheduling), migration `0001` (`health_scans`, `improvement_proposals`) | ✅ done | 13 core tests · 5 repository tests · 5 API tests |
| 18 | Specialists (ADR-015): documentation agent + `docs.write` for docs tasks, release readiness gate before DEPLOY, DevOps review in scans, research on explicit request | ✅ done | verify-check tests · 5 pipeline scenarios |
| 19 | Caching (ADR-014): TTL agent output cache in `cache_entries` (hard deny-list for code-changing agents, savings in usage ledger and cost stats), sha-keyed file summaries used by the context builder | ✅ done | 4 cache tests · summarizer and repository tests |
| 20 | Project Room stage 1 (ADR-030 + addendum): unified `conversations`/`conversation_messages` (migration `0002`), room service (sanitising, redaction, threads, seq cursors), bounded and deduplicated projection of orchestrator events, room API with RBAC/ACL/rate limit/audit and SSE, Room tab, demo seed | 🚧 in review | 13 core + 2 pipeline scenarios · 5 repository tests · 8 API tests incl. SSE replay |
| 21 | Dependency approval gate (ADR-031): hard-rule `dependency_addition` gate for new packages, lockfile-only additions, workflow `uses:`, MCP servers, Claude plugins and VS Code extensions at every autonomy level; fingerprint-scoped approvals, typed findings in the approvals API and UI; review fix: lockfiles are always diffed (labelled lockfile findings, "cannot inspect" for binary lockfiles, full npm/pnpm/bun/Gemfile/NuGet lock trees, overrides, Cargo patches, `-r` includes) | ✅ done | detector with hostile inputs · per-ecosystem smuggling tests · hard-rule, router backstop, 5 pipeline and API tests |

## Known constraints on the dev machine
* Docker daemon not running → sandbox defaults to `SANDBOX=none` (verification delegated to CI).
* No local PostgreSQL/Redis → embedded PGlite (ADR-002), DB-backed queue (ADR-004).

## Roadmap (approved order)
Plans are proposals until built; risky or irreversible actions always stay with a human.

Decided by the owner (2026-09-14): **every new dependency needs human approval**, whatever proposes it (Plugin
Scout, builder agent in a normal task, autopilot) and at every autonomy level. This covers package manifests,
workflow `uses:`, MCP/Claude/editor configs. It will be the `dependency_addition` approval gate in
`docs/plans/plugin-scout.md` and is built as a small security change right after PR #12.

1. ✅ **Health scan, agent output cache, specialist agents**: PR #12 merged (rows 17–19), including the concurrent-scan fix.
1a. 🚧 **`dependency_addition` approval gate**: every new dependency needs human approval (in progress).
2. 🚧 **Project Room + MCP server, leases, Kanban, milestones, roadmap**: ADR-030, `docs/plans/project-room.md`. Stage 1 (room on the unified conversation model) in review (row 20).
3. **Autopilot / away mode**: time- and budget-boxed unattended work. Questions are resolved via decision memory, then research, then an agent council with a critic on a different model; anything risky is parked for the human; there is a return digest. See `docs/plans/autopilot.md`.

Proposed, not yet scheduled:
* **In-app planning assistant** (idea → precise brief → project/milestones/tasks after confirmation): `docs/plans/planning-assistant.md`.
* **Plugin Scout** (per-project plugin recommendations with trust scoring, never auto-install): `docs/plans/plugin-scout.md`.
* **Provider accounts per owner** (several Claude/OpenAI accounts, per-account budgets, BYO-AI via MCP): `docs/research/multi-account-ai.md`.
* Known gaps: web UI tests, project profile editing, model create/delete, audit log page, memberships UI.
