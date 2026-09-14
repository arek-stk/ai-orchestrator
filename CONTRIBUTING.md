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
* When the lowest open `vX.Y` milestone has no open items, the **Milestone release** workflow releases `X.Y.0`: it
  retargets the release PR with a `Release-As` PR if needed and enables squash auto-merge. The merge still waits for
  the required checks and resolved conversations; afterwards the milestone is closed with a link to the release.
* You can always merge a release PR by hand. To pause the automation, add the `release:hold` label to the release PR
  or set the repository variable `AUTO_RELEASE` to `false`; close a Release-As PR to veto it. Run the workflow
  manually with `dry_run` to see its plan. Details: ADR-012 addendum in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Automation

* **CI** runs typecheck and tests on every pull request; it is required on `main`.
* **CodeQL**, **dependency review** and **OpenSSF Scorecard** scan for vulnerabilities.
* **Dependabot** opens grouped weekly updates; minor and patch updates auto-merge after CI passes.
* **Labeler** labels pull requests by the areas they touch; **stale** closes inactive issues after 74 days.

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
