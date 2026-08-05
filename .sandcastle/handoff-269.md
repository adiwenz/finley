# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`), Task 2 (make the REPL the obvious
place to explore), Task 3 (mirror the exploration rule into the implement prompt + guard both).
Tasks 4–20 remain — see the issue body.

## Live constraints
- The exploration rule now lives in two docs and is pinned by
  `packages/engine/src/comments.guard.test.ts`:
  - `AGENTS.md`, `## Testing & exploration` section.
  - `.sandcastle/new_flow/implement-prompt.md`, a bullet under `### 🛠️ Required Skills`.
  The guard asserts **both** docs match `/through the REPL/i` and `/pin what you observed/i`. If a
  later task rewords either place, keep those two phrases (or update the guard's patterns in the
  same commit) — otherwise the guard fails.
- `repl.ts` carries three read-only formatters over a `ProjectionResult` — `dumpMonths`,
  `waterfall`, `balances`. **Invariant:** they read a run, never call `run()`. A later task that
  touches these must keep the REPL from becoming a second implementation of the engine.
- `comments.guard.test.ts` only scans `*.ts(x)` under `packages/`, so it does not police
  `AGENTS.md`, root `repl.ts`/`playground.ts`, or the implement prompt for issue/PR numbers. Keep
  those files free of issue/PR numbers regardless.
- `npm run repl` and `npm run playground` exist in the root `package.json`. Both `AGENTS.md` and
  the implement prompt point at the REPL as `npx tsx repl.ts`, which still works.

## Dead ends
- (none)

## Deferred
- (none — everything below task 3 is owned by its declared task)
