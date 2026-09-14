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
| 9 | GitHub integration (Octokit adapter, webhooks) + Docker sandbox | 🚧 in progress | — |
| 10 | Server: config, auth/RBAC, API, SSE, scheduler tick, workers | ⏳ | — |
| 11 | Web dashboard (Next.js) | ⏳ | — |
| 12 | Security hardening + review | ⏳ | — |
| 13 | Optimisation: caching, decision reuse | ⏳ | — |

## Known constraints on the dev machine
* Docker daemon not running → sandbox defaults to `SANDBOX=none` (verification delegated to CI).
* No local PostgreSQL/Redis → embedded PGlite (ADR-002), DB-backed queue (ADR-004).
