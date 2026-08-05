# Finley — agent instructions

`CONTEXT.md` at the repo root is the canonical ubiquitous language. Use its vocabulary, and
respect its `_Avoid_` lines.

## Testing & exploration

To learn what the engine actually does, observe it through the REPL — `repl.ts`, run with
`npx tsx repl.ts`, which preloads a live `Projection` — then pin what you observed as a test.
Never a standalone script that gets written, read once and deleted, and never a language that
cannot import `@finley/engine`: a Python probe cannot reach the engine, so it only reimplements
the arithmetic and then confirms its own reimplementation — verification in the commit message,
nothing verified in fact.

Not yet knowing the expected value is not licence for a script. Observe the number in the REPL,
then — once it is known — write the test that asserts it. This is the step `/tdd` refuses to let
you shortcut by copying output straight into an assertion, so the REPL is where the assertion's
value is earned.

## Agent skills

### Issue tracker

GitHub Issues on `adiwenz/finley`, via the `gh` CLI. External pull requests are **not** a
triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Two roles only: `ready-for-agent` → **`Sandcastle`**, and `wontfix`. Do not create labels for
the other canonical roles. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root. **This repo does not use ADRs** — decisions
live in the spec or PRD issue that produced them, and in the code's doc-comments. See
`docs/agents/domain.md`.
