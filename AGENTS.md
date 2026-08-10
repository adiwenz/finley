# Finley — agent instructions

Browser-based financial life simulator: household inputs and life events → month-by-month projection
and solved retirement year.

## Start here

Use these as maps, not reading assignments:

* `README.md` — workspaces, dependency rules, npm scripts.
* `packages/engine/src/index.ts` — engine public API.
* `CONTEXT.md` — canonical domain language. Grep only the relevant term; respect `_Avoid_` guidance.

## Architecture

Dependency direction is strictly:

`app → rules → engine`

* `@finley/engine` — pure simulation. No I/O, app code, or jurisdiction-specific logic.
* `@finley/rules` — jurisdiction implementations.
* `@finley/app` — UI, persistence, user data.

Engine purity is enforced by `npm run check`.

### Engine map

* `facade/` — `Projection`, the only public entry point.
* `projection/` — simulation, waterfall, withdrawals, obligations, reports.
* `ledger/` — life events and validation.
* `authoring/` — write-side operations.
* `plan/` — authored model and IDs.
* `compile/` — plan → projection base.
* `retirement/` — retirement solver.
* `jurisdiction/` — jurisdiction seam.
* `input/` — declarative `ScenarioInput`.
* `testing/` — engine fixtures.

### App map

Prefer root-level `*View.ts` view-model modules before rendered components. Test through the
view-model seam unless the behavior is genuinely DOM-specific.

### Where to start

| Task              | Start                                                  |
| ----------------- | ------------------------------------------------------ |
| Authoring gesture | `engine/src/authoring/`, then `engine/src/index.ts`    |
| Simulation math   | `engine/src/projection/`                               |
| Tax/benefit rule  | `rules/src/`                                           |
| Panel behavior    | matching `app/src/*View.ts`                            |
| Life event        | `engine/src/ledger/eventTypes.ts` + `eventHandlers.ts` |
| Retirement answer | `engine/src/retirement/`                               |

## Work efficiently

Minimize model/tool round trips without sacrificing correctness.

### Explore once

* Batch independent reads/searches into the same turn.
* Prefer the named analogous implementation or repo map over broad exploration.
* Identify implementation, callers, public surface, and relevant tests before editing.
* Once ownership is clear, stop broad searching.
* Do not re-read files without a new specific question.
* Do not launch an Explore subagent when the path or reference implementation is already clear.
* Skip task bookkeeping for straightforward work.

### Edit in batches

* Make all already-understood related edits before reassessing.
* Do not alternate one small edit with one model/tool round trip when multiple changes follow from
  the same finding.
* After validation fails, inspect all relevant failures first and fix related failures together.
* Do not rerun validation after every individual fix.
* Compare against `main` only when it is genuinely unclear whether a failure is pre-existing.

Preferred workflow:

1. Inspect specification, reference implementation, relevant code, and tests.
2. Determine the full local change surface.
3. Make a coherent implementation batch.
4. Run the narrowest useful validation.
5. Inspect all relevant failures and fix them as a batch.
6. Re-run that validator.
7. Run broader validation once locally stable.
8. Run `npm run check` once at the end.
9. Review the final diff.

## Testing

Tests live beside source as `*.test.ts(x)`.

Use the narrowest useful command while iterating:

```bash id="7zgcz0"
npx vitest run packages/engine/src/retirement
npx vitest run packages/app/src/goalsView.test.ts
npx vitest run packages/engine
npm run typecheck
npm run check
```

Rules:

* Do not use `npm test` or `npm run check` as inner-loop debugging commands.
* Prefer a relevant test file before package-wide validation.
* Treat whole-repo `npm run typecheck` as broad validation, not an after-every-edit check.
* A typecheck run should produce a batch of information: inspect its relevant errors, fix them
  together, then rerun.
* Once typecheck passes, do not run it again unless later changes plausibly affect types.
* Run `npm run check` once after the implementation is stable.
* If the full check fails, fix using the smallest relevant validator, then rerun the full check.
* Capture long-command output once and inspect the saved output instead of rerunning the command.
* Never pipe a live validation command through `head`; save output first.
* Combine independent shell inspections into one Bash call when safe and readable.

### Behavioral probes

To learn engine behavior, use `repl.ts` via:

```bash id="1q64u0"
npx tsx repl.ts
```

Then pin the observed behavior in a test.

Do not create throwaway scripts to reproduce engine arithmetic, especially in languages that
cannot import `@finley/engine`.

### Test at the right abstraction

Prefer public behavior over implementation details.

Prefer `*View.ts` tests over rendered panel tests unless the assertion concerns DOM behavior.

## Ignore during product-code search

Skip `.claude/`, `.codex/`, `.sandcastle/`, `ralph/`, and `docs/agents/` when searching for
application behavior.

## Repo conventions

### Issues

GitHub Issues on `adiwenz/finley`, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage

Only `ready-for-agent` → `Sandcastle` and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

`CONTEXT.md` is the single domain-language reference. This repo does not use ADRs. Decisions live
in the issue/spec/PRD that produced them and in code doc-comments. See `docs/agents/domain.md`.
