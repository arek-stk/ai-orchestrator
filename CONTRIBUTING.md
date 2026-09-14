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

## Code style

* TypeScript strict mode, ESM, named exports.
* Comments explain *why*, not *what*.
* Keep secrets out of code, fixtures and logs — tests use obviously fake values.
