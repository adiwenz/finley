
# Finley — agent instructions

Browser-based financial life simulator: household inputs and life events → month-by-month projection and solved retirement year.

## Maps

Consult only when relevant:

* `README.md` — workspaces, dependencies, npm scripts.
* `packages/engine/src/index.ts` — engine public API.
* `CONTEXT.md` — canonical domain language. Grep the relevant term; respect `_Avoid_` guidance.

## Architecture

Dependency direction is strictly:

`app → rules → engine`

* `@finley/engine` — pure simulation; no I/O, app code, or jurisdiction-specific logic.
* `@finley/rules` — jurisdiction implementations.
* `@finley/app` — UI, persistence, user data.

`Projection` in `engine/src/facade/` is the engine's public entry point.

Start here:

| Change           | Start                                                  |
| ---------------- | ------------------------------------------------------ |
| Authoring        | `engine/src/authoring/`                                |
| Simulation       | `engine/src/projection/`                               |
| Tax/benefit rule | `rules/src/`                                           |
| Panel behavior   | matching `app/src/*View.ts`                            |
| Life event       | `engine/src/ledger/eventTypes.ts` + `eventHandlers.ts` |
| Retirement       | `engine/src/retirement/`                               |

Prefer app `*View.ts` view-models over rendered components unless behavior is genuinely DOM-specific.

## Execution

Minimize model/tool round trips without sacrificing correctness.

### Explore

* Batch independent reads and searches into the same turn.
* Prefer a named analogous implementation or the map above over broad repo exploration.
* In one focused exploration phase, identify the implementation, callers, public surface, and relevant tests.
* Once ownership is clear, stop broad searching.
* Do not reread files without a new specific question.
* Do not use an Explore subagent when the ownership path or reference implementation is already clear.
* Skip task bookkeeping for straightforward implementation work.

### Implement

* Make all already-understood related edits as one coherent batch.
* Do not alternate one small edit with another model/tool round trip when several edits follow from the same finding.
* When validation reports several relevant failures, inspect them all before editing and fix related failures together.
* Do not rerun validation after each individual fix.
* Do not compare against `main` merely because validation failed. Do so only when inspection cannot determine whether a relevant failure is pre-existing.

Use this sequence:

1. Inspect specification, reference implementation, relevant code, and tests.
2. Determine the local change surface.
3. Make the implementation batch.
4. Run directly relevant tests.
5. Inspect all relevant failures and fix them as a batch.
6. Rerun those targeted tests.
7. Run broader validation once.
8. Run `npm run check` once at the end.
9. Review the final diff.

## Validation

Tests live beside source as `*.test.ts(x)`.

### Inner loop

Use only tests directly relevant to changed behavior.

Examples:

```bash
npx vitest run packages/engine/src/retirement/foo.test.ts
npx vitest run packages/app/src/goalsView.test.ts
```

Do not use these as inner-loop commands:

```bash
npm test
npm run check
npm run typecheck
npx vitest run packages/engine
```

### Broader validation

After targeted tests pass:

* Run a relevant package-wide suite at most once before final validation when the change warrants it.
* Run whole-repo `npm run typecheck` once after implementation is locally stable.
* If typecheck fails, inspect all relevant errors, fix them together, then rerun it. Do not rerun after each fix.
* Once typecheck passes, do not run it again independently unless subsequent edits can plausibly affect types.
* Do not explicitly run `npm test`; the final gate covers the repository suite.
* Run `npm run check` once at the end.

If `npm run check` fails:

1. Save and inspect the complete relevant failure output.
2. Fix failures using the narrowest relevant validator.
3. Address all known related failures before rerunning.
4. Rerun `npm run check` only after those fixes are complete.

Do not run a baseline `git stash → validate main → git stash pop` comparison unless a failure is outside changed code and remains genuinely ambiguous after inspection.

Capture long-command output once and inspect the saved output. Never rerun an expensive command merely to see another part of its output.

Combine independent shell inspections into one Bash call when safe and readable.

## Behavioral probes

Use `npx tsx repl.ts` to observe engine behavior, then pin the observation in a test.

Do not create throwaway scripts that reimplement engine arithmetic.

## Testing boundaries

Test public behavior, not private implementation details.

Prefer `*View.ts` tests over rendered panel tests unless the assertion concerns DOM behavior.

## Ignore during product search

Skip `.claude/`, `.codex/`, `.sandcastle/`, `ralph/`, and `docs/agents/` when searching for application behavior.

## Repo conventions

* Issues: GitHub Issues on `adiwenz/finley`; see `docs/agents/issue-tracker.md`.
* Triage: only `ready-for-agent` → `Sandcastle` and `wontfix`; see `docs/agents/triage-labels.md`.
* Domain: `CONTEXT.md` is canonical. No ADRs; decisions live in the issue/spec/PRD and code doc-comments.
