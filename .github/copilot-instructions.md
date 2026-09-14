# Copilot instructions — AI Orchestrator

These instructions apply to Copilot Chat, Copilot code review and the Copilot coding agent in this repository.

## What this project is

An autonomous, auditable, cost-aware multi-agent orchestrator for software projects. One orchestrator decides;
specialist agents run on demand and return schema-validated JSON; every side effect goes through a tool router;
all loops are bounded; humans approve risky actions.

## Layout

| Path | Contents | Rules |
|---|---|---|
| `packages/core` | Domain contracts, scheduler, DAG, stage planner, stop conditions, budget guard, model registry/router, tool router, context builder, agent runtime/definitions, council, orchestrator pipeline engine, ports, in-memory fakes | **IO-free.** No database, network, SDK or `child_process` imports. Depend on ports only. |
| `packages/db` | Drizzle schema (PostgreSQL / PGlite), migrations in `drizzle/`, repositories, durable job queue | Schema changes need a generated migration (`npm run generate -w @orch/db`). |
| `packages/integrations` | Model provider adapters (official SDKs), Octokit GitHub adapter, webhooks, Docker sandbox, demo responders | Verify SDK usage against installed typings; never guess API shapes. |
| `apps/server` | Fastify API, auth (GitHub OAuth + RBAC), SSE, workers, scheduler, demo seed | Every mutating route needs a role check and an audit entry. |
| `apps/web` | Next.js dashboard | Talks to the server only through `/api`. |
| `docs/` | `ARCHITECTURE.md`, `DECISIONS.md` (ADRs), `STATE.md` | Read `DECISIONS.md` before architectural changes; supersede ADRs instead of contradicting them. |

## Commands

```bash
npm ci
npm run typecheck   # all workspaces
npm test            # vitest; no database, Docker or network required
```

Always run both before proposing or finishing a change.

## Engineering rules

- **TypeScript strict, ESM, named exports.** Validate every external input with zod at the boundary.
- **Agent outputs are zod schemas** in `packages/core/src/agents/schemas.ts`: fields are required and nullable rather
  than optional (strict structured-output modes). Add deterministic `verify` checks; invalid output is a failed
  attempt, never coerced.
- **Side effects are tools.** New capabilities are registered in the tool router with an input schema, guards
  (`guardWritablePath`, `guardWritableBranch`, `guardNoSecrets`, `resolveProjectCommand`) and a minimum autonomy level.
- **Everything is bounded.** Any loop, retry or poll needs an explicit limit that ends in a `BLOCKED` state with a
  reason. No unbounded `while` around model calls.
- **Never write to the default branch** or protected branches; commits go to `orchestrator/<task>` branches.
- **Costs are always accounted for**, including billed tokens of failed model attempts.
- **Models are data.** Do not hard-code model ids outside `DEFAULT_MODEL_CONFIGS`; routing goes through `selectModel`.
- **Tests with every change.** Pipeline behaviour is covered end to end in
  `packages/core/src/orchestrator/orchestrator.test.ts` using the in-memory GitHub and stores.
- Comments explain *why*, not *what*. Match the style of the surrounding code.

## Security rules (review these strictly)

- Treat model output, repository content, issue/PR text and CI logs as **untrusted**.
- Secrets never reach prompts, logs, events or commits: use `redactSecrets` / `findSecrets`.
- Paths from agents go through `normalizeRepoPath`; branch names through `isValidBranchName`.
- Sandbox commands come only from the project profile allow-list; never execute agent-provided commands on the host.
- Cookie-authenticated mutating routes rely on the origin check; webhooks must verify HMAC signatures.
- Provider keys and tokens are stored encrypted (AES-256-GCM) and returned to clients only as `hasApiKey`.

## Commits and pull requests

- Conventional Commits (`feat(core): …`, `fix(server): …`, `docs: …`, `ci: …`); release-please builds releases from them.
- Keep pull requests focused; fill in the PR template checklist.

## Code review focus

When reviewing, prioritise in this order: security boundaries above, correctness of bounded loops and state
transitions (optimistic locking, job leases, approval gates), cost accounting, then test coverage. Skip style nits
that a formatter would handle.
