# Plan: orchestration intelligence (product improvement, caching, specialists)

Request (2026-09-14): "was kann man noch weiter verbessern nimm 2 agents und die planen und bauen weiter".
Scope of this plan: master prompt §14 (autonomous product improvement), §31 (caching), §5 (specialists).

## 1. Gap analysis

| Spec | State on `main` (v0.2.0) | Gap |
|---|---|---|
| §14 health scan + proposals | `projects.healthScore` column exists, always 100. Analysis agent lists `techDebt`, nothing acts on it. | No scan, no proposals, no ROI ranking, no acceptance flow, no events/API. |
| §14 "no unrequested large changes" | Approval gates guard risky change sets. | Nothing decides which improvements may start on their own. |
| §31 file summaries | `repo_files.summary`/`summary_sha` columns exist; indexer keeps them per blob SHA; nothing fills them. | No summarizer; context builder cannot tell stale from fresh summaries. |
| §31 agent output cache | `cache_entries` table unused. Analysis reuse per head SHA via memories, decision reuse via question key. | No generic, TTL-bound cache; savings invisible in cost data. |
| §5 specialists | Roles `researcher`, `documentation`, `devops`, `release` exist in enums/tool permissions only. | No definitions, schemas, verify checks or integration points. |

## 2. Design

### 2.1 Project Health Scan (`packages/core/src/intelligence`)
* **Signals (deterministic, no model):** repository index (source vs. test files, untested modules ranked by
  importers, README/CHANGELOG/CI/Dockerfile presence, committed sensitive files, very large modules), dependency
  manifests (`package.json`, `requirements.txt`: unpinned `*`/`latest`/unbounded ranges), failure memory (recurring
  fingerprints), recent run outcomes (failure/blocked rate), blocked tasks.
* **Health score:** 100 minus capped penalties per component; the breakdown is persisted. Deterministic and
  reproducible — model output never changes the score.
* **Proposals:** deterministic heuristics + one `health_scan` agent call (signals and heuristic findings in the prompt,
  it adds grounded findings such as UX/performance) + one conditional `devops_review` call (only when CI/Docker signals
  exist). Each proposal: category (`tech_debt | missing_tests | outdated_dependencies | security_risk | performance |
  ux | documentation`), impact, effort, risk, evidence, affected paths, acceptance criteria.
* **ROI priority:** `roi = impact(1/2/3) * 10 / (effort(1/2/4) * risk(1/1.5/2.5))`, mapped to priority 1–10.
* **Dedupe:** fingerprint = hash(category, normalised title); unique per project. Re-seen proposals only bump
  `occurrences`; dismissed ones never come back.
* **Acceptance:** explicit (API) or automatic when `autonomyLevel >= 3 AND risk = low AND effort = small`, capped at
  3 per scan and 5 open auto-created tasks per project. Acceptance creates a `BACKLOG` task (kind from category,
  complexity from effort, priority ≤ 5 so improvements never pre-empt requested work).
* **Job:** `project.health_scan` job (dedupe per project), bounded: ≤ 2 agent calls + ≤ 2 summary batches,
  ≤ 5 manifests, ≤ 20 proposals, scan cost cap (`maxScanCostUsd`, default $1) enforced as run budget in the
  `AgentRuntime` (global/project budgets apply as usual). Budget pause → heuristics-only scan, never a failure.
  Daily re-scan for projects at autonomy ≥ 1 with a repository (manual only at level 0).

### 2.2 Caching
* **File summaries:** `file_summary` agent (fast tier), batches of ≤ 6 files, ≤ 2 batches per call site, only files ≥
  2 KB (smaller files are cheaper in full), stale or missing summaries first, ranked by task relevance or importers.
  Stored with `summary_sha = blob sha`; the store only writes when the sha still matches. Context builder ignores stale
  summaries. Runs in ANALYZE (best effort) and in the health scan.
* **Agent output cache:** `AgentDefinition.cacheTtlMs` opt-in; key = sha256(project, definition key, model id, system
  prompt, rendered prompt). Hits are re-validated (schema + verify), recorded as an agent run with `cache_hit`, and as
  a ledger row with `cost_usd = 0`, `cache_hit = true`, `saved_usd = original cost`. A hard deny-list keeps build, test,
  debug, review, security, plan, design, documentation and release definitions uncached even if misconfigured.
  Enabled for `analyze` (24 h), `file_summary` (30 d), `health_scan` (12 h). Cache is project-scoped (no cross-project reuse).

### 2.3 Specialists (no unnecessary agents)
| Agent | Activation | Output | Tools |
|---|---|---|---|
| Research (`researcher`) | Only via explicit API request (`POST /api/projects/:id/research`); never in the default pipeline. Result stored as memory; PLAN includes notes linked to its task. | findings with sources + confidence, recommendation, open questions | none registered (context only) |
| Documentation (`documentation`) | IMPLEMENT for `docs` tasks instead of the build agent | file changes restricted to documentation paths | new `docs.write` tool (doc paths only) |
| DevOps (`devops`) | Health scan, only when CI/Docker signals exist | CI/Docker/deploy suggestions as proposals | read-only |
| Release readiness (`release`) | DEPLOY, before merge/dispatch and before the deploy approval | per-check status (tests, security, migrations, changelog, version, ci), blockers, verdict | read-only |

Release readiness: deterministic checks first (hard failures block without a model call), then the agent;
`not_ready` blocks the run with the blockers; readiness is attached to the deploy approval.

## 3. Data model (migration `0001_*`)
* `health_scans`: id, project, status (`queued|running|completed|failed`), trigger, requested_by, health_score,
  previous_score, breakdown, signals, proposals_created, proposals_seen, auto_accepted, agent_status, cost_usd,
  summary, error, timestamps.
* `improvement_proposals`: id, project, scan, fingerprint (unique per project), category, title, description, rationale,
  evidence, affected_paths, acceptance_criteria, impact, effort, risk, roi_score, priority, source
  (`heuristic|agent|devops`), status (`proposed|accepted|dismissed`), task (set null), auto_accepted, decided_by,
  decided_at, dismiss_reason, occurrences, timestamps.
* `usage_ledger`: `cache_hit`, `saved_usd`. `agent_runs`: `cache_hit`. `cache_entries`: `hits`.

## 4. API (`apps/server/src/routes-health.ts`, RBAC + audit on every mutation)
| Method | Path | Role |
|---|---|---|
| POST | `/api/projects/:id/health-scans` → 202, queued scan (existing active scan is returned) | operator |
| GET | `/api/projects/:id/health-scans` | viewer |
| GET | `/api/projects/:id/improvements?status=` | viewer |
| POST | `/api/improvements/:id/accept` → proposal + BACKLOG task | operator |
| POST | `/api/improvements/:id/dismiss` `{reason}` | operator |
| POST | `/api/projects/:id/research` `{question, taskId?}` → 202 | operator |

Events: `project.health_scanned`, `improvement.proposed`, `improvement.accepted`, `improvement.dismissed`,
`release.readiness`, `research.completed`; `agent.completed` gains `cached`.

## 5. Test plan
* core: signals/score/ROI/heuristics; scanner (auto-accept only at level ≥ 3 for low/small, caps, dedupe, dismissed
  stays dismissed, budget pause → heuristics only); summarizer (sha freshness, batching bound); runtime cache (hit
  skips provider and records savings, deny-list, invalid cached value = miss); verify checks of all new agents;
  pipeline: docs task via documentation agent + `docs.write` rejects code paths; DEPLOY readiness pass → approval,
  `not_ready` → blocked.
* db: proposal upsert/accept/dismiss exactly once, scans, cache expiry + hits, savings in usage stats, sha-guarded
  summary updates.
* server: scan through API + worker → score persisted, proposals listed, accept/dismiss with audit, viewer denied,
  research job stores a memory.

## 6. Non-goals
* Registry lookups for "outdated" versions (needs a network `dependency.scan` tool); only unpinned/unsafe ranges and
  model findings grounded in manifests.
* Web research tool (`research.web`) — research works from repository context and memory only.
* UI in `apps/web`; re-opening proposals whose improvement task finished but the finding persists.
* Automatic application of DevOps suggestions outside the normal task pipeline (they become proposals).
