# Contributing

Thanks for your interest in improving the AI Orchestrator!

## Development setup

```bash
npm install
npm run typecheck   # tsc in every workspace
npm test            # vitest, no database or Docker required (embedded PGlite, in-memory GitHub)
```

## Workflow

1. Open an issue for larger changes so the approach can be discussed first.
2. Create a feature branch from `main`.
3. Write or update tests together with the code. Every module ships with tests; the pipeline has end-to-end
   scenarios in `packages/core/src/orchestrator/orchestrator.test.ts`.
4. Make sure `npm run typecheck` and `npm test` pass.
5. Open a pull request describing what changed and why.

## Architecture rules

* **Check the decision memory first.** Architectural choices are recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).
  Do not contradict an accepted decision — add a new ADR that supersedes it.
* **Keep `packages/core` IO-free.** Core depends only on ports (interfaces). Database, network, SDK and process code
  belongs in `packages/db`, `packages/integrations` or the apps.
* **Every side effect goes through the tool router.** New capabilities are new tools with an input schema, guards and
  a minimum autonomy level.
* **Agent outputs are schemas.** Add a zod schema and deterministic `verify` checks; invalid output is a failed
  attempt, never coerced.
* **Everything is bounded.** Loops need an explicit limit that ends in a blocked state with a reason.
* **Model providers are adapters.** Use the provider's official SDK and verify API usage against its typings.

## Commits and releases

* Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles:
  `feat(core): …`, `fix(db): …`, `docs: …`, `ci: …`, `chore(deps): …`.
* Releases are automated: release-please keeps a release PR with the next version and `CHANGELOG.md` up to date;
  merging it publishes the GitHub release.

## Releases & milestones

* Roadmap milestones are named `vX.Y — <theme>` (for example `v0.5 — Project Room`); unscheduled work lives in
  `Backlog — proposed`. Put issues and PRs into the milestone they deliver; a PR without one gets it from a
  `milestone:vX.Y` label or from `Closes #N` pointing at an issue in that milestone.
* When the lowest open `vX.Y` milestone has no open items, the **Milestone release** workflow prepares `X.Y.0`: it
  retargets the release PR with a `Release-As` PR if needed, runs CI on both and comments when the release PR is
  ready. After the release is published it adds the milestone link to the notes and closes the milestone.
* **Safe mode (default):** nothing is merged automatically. A maintainer merges the Release-As PR (if any) and then
  the release PR.
* **Full mode:** set the repository variable `AUTO_RELEASE_MERGE` to exactly `true` and the workflow enables squash
  auto-merge on those PRs. `main` has no required reviews and does not enforce admins, so the bot then lands release
  commits without a human; prefer safe mode, or add required reviews / a dedicated GitHub App first.
* To pause everything, add the `release:hold` label to the release PR or set the repository variable `AUTO_RELEASE`
  to `false`; close a Release-As PR to veto it. Run the workflow manually with `dry_run` to see its plan. Bot merges
  trigger no workflows, so finishing a release can take up to ~2 hours (scheduled fallback). Details: ADR-012
  addendum in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Automation

* **CI** runs typecheck and tests on every pull request; it is required on `main`.
* **CodeQL**, **dependency review** and **OpenSSF Scorecard** scan for vulnerabilities.
* **Dependabot** opens grouped weekly updates; minor and patch updates auto-merge after CI passes.
* **Labeler** labels pull requests by the areas they touch; **stale** closes inactive issues after 74 days.
* **Repo Guardian** (`.github/workflows/repo-guardian.yml`) checks the repository every 6 hours, after CI on `main`
  and on docs pushes: CI and scheduled workflows on `main`, code scanning, Dependabot and secret scanning alerts, open
  pull requests (failing checks, conflicts, unresolved review threads, no activity for 7 days), that branch protection
  still requires `Typecheck and test`, docs consistency (`docs/STATE.md` rows marked 🚧 for more than 14 days, unique
  ADR numbers, referenced plans, relative markdown links), branches without a PR older than 30 days and Dependabot PRs
  older than 7 days. Results live in one "Repo Guardian report" issue that closes itself when everything is ok; if a
  check could not run (API error), the report is marked degraded and the issue stays open.
  Run the docs part locally with `node .github/scripts/repo-guardian/repo-guardian.mjs --docs`.
  * Optional secret `REPO_GUARDIAN_TOKEN`: a fine-grained personal access token for this repository only with
    read-only **Secret scanning alerts** and **Administration** permissions. Without it, secret scanning shows as
    "not checked" and branch protection is read from the public protection summary.

## AI assistance

* Copilot and other coding agents follow [`.github/copilot-instructions.md`](.github/copilot-instructions.md) and
  [`AGENTS.md`](AGENTS.md); keep them in sync with architecture changes.
* Copilot reviews every pull request automatically. Treat its comments like any reviewer's: fix or answer, then
  resolve the conversation (required on `main`).
* Issues can be assigned to the Copilot coding agent; `copilot-setup-steps.yml` prepares its environment.
* AI triage labels and PR summaries are advisory. Correct them when they are wrong.

## Code style

* TypeScript strict mode, ESM, named exports.
* Comments explain *why*, not *what*.
* Keep secrets out of code, fixtures and logs — tests use obviously fake values.
