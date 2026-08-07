# Summary — issue #265: Optimize the retirement solver

## Overview

`earliestFullRetirementAge` binary-searches candidate stop-working ages, and each probe ran a
**full** `simulateHousehold` pass — the most expensive query the engine exposes (~7.8 ms per
projection, ~8 projections per solve). This branch trims that cost along five independent levers,
each a pure read off the same survival signal (`planSurvives`) so panel and graph can never
disagree. The two structural facts the whole issue rests on — the sim is a strict forward
recurrence, and a candidate boundary changes only the income-series tail — are what make every
optimization sound.

Tasks 1–5 landed with code and tests; task 6 was already satisfied by existing memoization; task 7
is optional and deferred (measure-first).

## RGR Verification Details

Every task was built test-first, observing behaviour through the engine's public seams before
pinning it:

- **Task 1** — RED: a survival-only sim must truncate at the first insolvent month
  (`simulate.test.ts` asserted `lean.months.length === firstInsolvent + 1`, which failed at the
  full length 6). GREEN: the loop breaks at the first insolvent month, after block detection.
- **Task 2** — RED: survival-only months must carry no `flows`/payment records (failed — full
  assembly still ran). GREEN: the reporting assembly moved into one `if (!survivalOnly)` block.
- **Task 3** — RED: resuming from a mid-run checkpoint must reproduce the tail byte-for-byte
  (`resume from a mid-run checkpoint` test). GREEN: `forkSimState` + resume/`onCheckpoint` params.
  A second gate — `checkpoint-resumed search finds the same age as a brute-force full-projection
  scan` — pins the wired search against independent full projections across every fixture shape.
- **Task 4** — RED: `rebaseStopWorking(authored, …)` must deep-equal `createProjectionBase(…,
  stopWorking)` (failed — function absent). GREEN: extracted `compileInitialIncomeSeries` /
  `buildStandingPerson`, shared by both paths.
- **Task 5** — no behaviour change; the full retirement suite and app presets acceptance tests
  pin that `solveRetirement`'s output is unchanged while the redundant recompiles are removed.

Final gate: `npm run check` — purity + typecheck + **1842 tests green** (45 todo).

## Key Decisions & Why

- **Survival-only is one mode, two levers (tasks 1+2).** The only caller — the search — reads
  neither the tail past the first failure nor the per-month flow record, so early-exit and
  reporting-skip fold into one flag. The early-exit break sits *after* block detection, so a
  month that both blocks and goes insolvent still records `status: "blocked"` — keeping the
  truncated series' verdict identical to a full run.
- **The full evaluation stays full.** `evaluateFullRetirementAtAge` and the block probe run the
  full projection on purpose: they report `blocked`/`onTrackFraction`/`blockedAtMonth`, which
  diverge from the fast path in the rare *insolvent-then-blocked* case. Only `.feasible` is
  fast-path-safe, and only the search uses it.
- **Checkpoint reuse rests on prefix identity (task 3).** One `hi = lifeExpectancy` pass caps no
  normal job and carries a continuation job through year(hi) ≥ every pre-`k` month, so months
  `[0, k)` are byte-identical income for every candidate with `k = retirementMonth(A)`. The
  checkpoint entering month `k` therefore seeds that candidate's tail exactly, and `planSurvives`
  of the tail is the candidate's survival because the skipped prefix is known solvent (the hi pass
  survived it). `forkSimState` shares the immutable arrays and copies every mutable Map — cloning
  `earningsByPerson`'s inner accumulators, which `addEarnings` mutates in place.
- **`rebaseStopWorking` keeps compilation a single read (task 4).** Only the income series and the
  carried `stopWorking` depend on the boundary; a deep-equality test guarantees the shortcut can
  never drift from a full recompile.
- **App-side reuse was declined (task 5).** The issue floated threading the answer-age run out to
  the app's `runAtStopWorkingAge`. That call is gated on the preview toggle (off in the common
  case) while the solve runs on every apply, so threading a full sim through every solve would
  pessimize the common path. Only the engine-side recompile reuse was taken.
- **Task 6 was already satisfied.** `main.tsx` memoizes the solve (`retirementView`) on
  `[projection]`, and `projection` on `[state]` — transitively keyed on committed state, the same
  treatment the main projection run gets. Further deduping (idempotent applies) would need a
  costly deep-equality on committed state and is out of scope for "memoize the solve."
- **Task 7 deferred.** Explicitly optional and measure-first; after tasks 1–5 the search is
  already cheap, so a tighter seed window is unlikely to pay for its added complexity.

## Changes Made

- **`packages/engine/src/projection/simulate.ts`** — `SimulateOptions` gains `survivalOnly`,
  `onCheckpoint`, and `resume`; the month loop early-exits at the first insolvent month under
  `survivalOnly`, guards all reporting assembly behind `!survivalOnly`, seeds from a checkpoint
  and emits only the tail under `resume`, and forks a checkpoint at each month's top under
  `onCheckpoint`.
- **`packages/engine/src/projection/runState.ts`** — new `forkSimState`: shares the immutable
  arrays, copies every mutable Map, deep-clones `earningsByPerson`'s inner accumulators.
- **`packages/engine/src/compile/projectionBase.ts`** — extracted `buildStandingPerson` and
  `compileInitialIncomeSeries`; new `rebaseStopWorking` re-derives only the income-series tail
  from an authored base.
- **`packages/engine/src/retirement/retirementSolver.ts`** — `earliestFullRetirementAge` hoists
  the authored base, checkpoints one hi pass, and resumes each candidate from its stop-working
  month running survival-only; `solveRetirement` compiles the authored base once and threads it
  through `*FromBase` cores (`plannedWorkStopAgeFromBase`, `authoredPlanSurvivesFromBase`,
  `continuedJobsFromBase`); the authored-survival check runs survival-only.
- **Tests** — `simulate.test.ts` (survival-only early-exit, reporting-skip, resume), 
  `projectionBase.test.ts` (`rebaseStopWorking` equals a full recompile), `retirementSolver.test.ts`
  (survival-only fast path agrees at every age; checkpoint-resumed search equals a brute-force
  scan; the fast path refuses a blocked plan).

## Verification & Testing

- `npm run check`: purity ✓, typecheck ✓, **1842 tests passed** (45 todo), 128 test files.
- Engine suite: 1054 tests. The load-bearing invariant — the solved `fullRetirementAge` and every
  feasibility verdict match the full-horizon path — is pinned across surviving, must-work-longer,
  never-surviving, and blocked fixtures, and the app's real-jurisdiction preset acceptance tests
  (panel vs graph) are unaffected.
