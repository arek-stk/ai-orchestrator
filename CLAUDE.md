# Claude Code instructions

@AGENTS.md

## Shared project memory

This repository is the shared memory for everyone working on it — humans and every AI assistant (Claude Code,
Copilot, Codex, Cursor, …). Knowledge that only lives in one person's local assistant memory is invisible to the
rest of the team, so record it here instead.

| What | Where |
| --- | --- |
| Current state, what is done and what is next | `docs/STATE.md` |
| Architecture decisions (ADRs) — never contradict, supersede with a new ADR | `docs/DECISIONS.md` |
| System overview and module boundaries | `docs/ARCHITECTURE.md` |
| Approved and proposed feature plans | `docs/plans/` |
| Research notes with sources | `docs/research/` |
| Coding rules for all AI assistants | `AGENTS.md`, `.github/copilot-instructions.md` |

When you finish a piece of work:

1. Update `docs/STATE.md` if the state of the project changed.
2. Add an ADR to `docs/DECISIONS.md` for any decision that later work must respect.
3. Put reusable findings in `docs/research/` or `docs/plans/` rather than in a private memory.

The repository is public: never write secrets, tokens, API keys, personal data or private notes into these files.
