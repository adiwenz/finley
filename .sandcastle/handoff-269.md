# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`), Task 2 (make the REPL the obvious
place to explore). Tasks 3–20 remain — see the issue body.

## Live constraints
- The exploration rule lives in a `## Testing & exploration` section of `AGENTS.md`. Task 3 pins
  it: it extends `packages/engine/src/comments.guard.test.ts` to assert both `AGENTS.md` and
  `.sandcastle/new_flow/implement-prompt.md` still carry the rule. If you reword the section, keep
  the phrasing the guard matches (task 3 chooses those patterns).
- `npm run repl` and `npm run playground` now exist in the root `package.json`. `AGENTS.md` still
  points at the REPL as `npx tsx repl.ts`, which also still works — I deliberately left AGENTS.md
  untouched (task 2's bullets don't include it, and task 3 owns AGENTS.md phrasing + its guard).
  When task 3 mirrors the rule into the implement prompt, it may prefer `npm run repl`.
- `repl.ts` now carries three read-only formatters over a `ProjectionResult` — `dumpMonths`,
  `waterfall`, `balances`. **Invariant to preserve:** they read a run, never call `run()`. The
  point is that the REPL must not become a second implementation of the engine; a later task that
  touches these must keep that property.
- The guard (`comments.guard.test.ts`) only scans `*.ts(x)` under `packages/`, so it does not police
  `AGENTS.md` or the root `repl.ts`/`playground.ts` for issue/PR numbers — task 3 adds the AGENTS.md
  check. Keep `AGENTS.md`, `repl.ts`, `playground.ts` free of issue/PR numbers regardless (I removed
  the `(issue #70)` references from both root headers when rewriting them).

## Dead ends
- (none)

## Deferred
- (none — everything below task 2 is owned by its declared task)
