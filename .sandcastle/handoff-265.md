# Handoff — issue 265

Optimising the retirement solver. The issue body lists 7 tasks; I am doing them in order as
whole-issue mode, one commit per task. Read the issue for the full task text.

**Done so far:**
- **Task 1 — survival-only, early-exit sim path.** DONE.
- **Task 2 — skip reporting-only work during the search.** DONE.
- **Task 4 — hoist boundary-independent compilation out of the per-candidate loop.** DONE (this
  commit). Done out of numeric order (before 3) because it's independent and lower-risk.

- **Task 3 — resumable core + prefix checkpoints.** DONE.
- **Task 5 — reuse the solved run instead of recomputing.** DONE (this commit), engine side.

**Remaining:** tasks 6, 7 (6 = memoize solve on committed state; 7 = optional
seed-from-plannedWorkStopAge).

## Live constraints
- **The load-bearing invariant:** every fast path must be a pure read off the SAME survival
  signal (`planSurvives`, `retirementSolver.ts`). Panel and graph must never disagree. Keep
  `retirementSolver.test.ts` green — it pins this.
- **`survivalOnly` semantics (task 1, `simulate.ts`):** `simulateHousehold(input, jur, {
  survivalOnly: true })` breaks the month loop at the FIRST insolvent month, AFTER the block-
  detection break. So: (a) `planSurvives` on the truncated series is the identical verdict to a
  full run — it reads the last emitted (insolvent) month; (b) a block still records `status:
  "blocked"` in both modes. This equivalence is why `earliestFullRetirementAge`'s binary-search
  predicate now calls `projectFullRetirement(..., { survivalOnly: true })`.
- **`SimulateOptions` is threaded** through `projectScenarioParts` → `projectScenario` →
  `projectFullRetirement` (4th optional arg each). Add future trim flags to the SAME interface.
- **Task 2 folded into `survivalOnly`, not a separate flag.** The only `survivalOnly` caller is
  the search, which reads neither flows nor payment records — so the reporting assembly
  (`buildFlows`, `resolveFundingAttribution`, `resolvedFunding`, `buildLiabilityPaymentRecords`,
  per-source tax/payroll splits) is now inside a single `if (!survivalOnly)` block in the month
  loop, placed AFTER the state mutations. survivalOnly months therefore carry `flows: undefined`
  and empty `liabilityPaymentRecords`. The attribution block was MOVED below the state mutations
  (`applyAssetTransfers`/`compoundAssets`/`advanceLiabilities`/`advanceProperties`); its inputs
  are captured locals those mutations don't touch, so full-path flow values are byte-identical
  (all flow/report tests still green). `appliedLiabilityPayments` (the funded total that moves
  state) stays OUTSIDE the guard — do not move it in.
- **`evaluateFullRetirementAtAge` still runs the FULL projection** (not survival-only) on purpose:
  it reports `blocked`/`onTrackFraction`, which diverge from the fast path in the rare
  "insolvent-at-k then blocked-at-j>k" case. Only `.feasible` is fast-path-safe. Do not switch
  the reported evaluation to survivalOnly without handling that divergence.

- **Task 4 compilation hoist (`projectionBase.ts` + `retirementSolver.ts`):** only
  `initialIncomeSeries` and the carried `stopWorking` field depend on the boundary; everything
  else in `LedgerBaseConfig` is boundary-independent. `rebaseStopWorking(base, budget, ctx,
  stopWorking)` re-derives just the income series and must stay byte-identical to
  `createProjectionBase(budget, ctx, stopWorking)` — pinned by the `rebaseStopWorking` test in
  `projectionBase.test.ts`. `earliestFullRetirementAge` compiles the authored base once and calls
  `rebaseStopWorking` per candidate, then `simulateFromBase` (extracted from
  `projectScenarioParts`) runs interpret + buildHouseholdSimInput + survival-only sim. If a future
  field on the base becomes boundary-dependent, `rebaseStopWorking` must be updated or the test
  will (correctly) fail.
- **Task 3 resumable core (`simulate.ts`, `runState.ts`):** `simulateHousehold` now takes
  `options.resume = { startMonth, seedState }` (seed the loop from a checkpoint and emit only the
  tail) and `options.onCheckpoint(month, fork)` (called at each month's TOP with a fork of the
  entering state). `forkSimState` (runState.ts) shares the immutable arrays and copies every
  mutable Map — `earningsByPerson`'s inner Maps are cloned (mutated in place by `addEarnings`).
  Proven byte-identical by the "resume from a mid-run checkpoint" test in simulate.test.ts.
  `earliestFullRetirementAge` now uses it: (1) one `hi = lifeExpectancy` survival-only pass with
  `onCheckpoint` capturing forks into `checkpoints[month]`; that pass caps no normal job and
  carries a continuation job through year(hi) ≥ every pre-`k` month, so the prefix `[0, k)` income
  is identical for every candidate A with `k = retirementMonth(A)`. (2) If the hi pass fails →
  return null. (3) Else the binary-search predicate resumes each age A from
  `forkSimState(checkpoints[k])` at `startMonth = k` with the candidate's own simInput (`k >=
  horizon` short-circuits to survives). Correctness gate: "checkpoint-resumed search finds the
  same age as a brute-force full-projection scan" in retirementSolver.test.ts — keep it green
  through any future change to the sim state or fork.

- **Task 5 (`retirementSolver.ts`):** `solveRetirement` now compiles the authored base ONCE and
  threads it to every read via `*FromBase` cores (`plannedWorkStopAgeFromBase`,
  `authoredPlanSurvivesFromBase`, `continuedJobsFromBase`, `earliestFullRetirementAge`'s
  `sharedAuthoredBase` param). The public wrappers (unchanged signatures, heavily used by app +
  tests) just compile the base then delegate. `authoredPlanSurvives` now runs survival-only. The
  block probe deliberately stays a FULL run — a block can follow an insolvency, and survival-only
  would early-exit before seeing it, misreporting `blocked`. Correctness gate: all existing
  solveRetirement tests (they pin the whole solution) plus the app presets acceptance test.

## Dead ends
- **Task 5 app-side reuse NOT done, on purpose.** The issue suggests threading the answer-age
  full run out to the app's `runAtStopWorkingAge` (charts). But that call is gated on the
  `previewRetirement` toggle (`main.tsx`), OFF in the common case, while `solveRetirement` runs on
  every apply. Threading a full flow sim through every solve to save the app one only-when-
  previewing sim pessimizes the common path — so only the engine-side recompile reuse was taken.

## Deferred
- **Task 7 (seed the search from `plannedWorkStopAge`).** Explicitly optional and "measure before
  building" in the issue. After tasks 1–5 the search is already cheap (survival early-exit + no
  reporting + prefix-checkpoint resume + hoisted compile), so a tighter seed window is unlikely to
  pay for its added binary-search complexity. Left unbuilt pending a measurement showing it helps.
