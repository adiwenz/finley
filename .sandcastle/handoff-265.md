# Handoff — issue 265

Optimising the retirement solver. The issue body lists 7 tasks; I am doing them in order as
whole-issue mode, one commit per task. Read the issue for the full task text.

**Done so far:**
- **Task 1 — survival-only, early-exit sim path.** DONE (this commit).

**Remaining:** tasks 2–7 (2 = skip reporting-only work; 3 = resumable core + prefix checkpoints;
4 = hoist boundary-independent compilation; 5 = reuse solved run; 6 = memoize solve on committed
state; 7 = optional seed-from-plannedWorkStopAge).

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
  `projectFullRetirement` (4th optional arg each). Task 2 should add its flag to the SAME
  `SimulateOptions` interface so the search passes `{ survivalOnly: true, <task2 flag> }`.
- **`evaluateFullRetirementAtAge` still runs the FULL projection** (not survival-only) on purpose:
  it reports `blocked`/`onTrackFraction`, which diverge from the fast path in the rare
  "insolvent-at-k then blocked-at-j>k" case. Only `.feasible` is fast-path-safe. Do not switch
  the reported evaluation to survivalOnly without handling that divergence.

## Dead ends
- (none yet)

## Deferred
- (none yet)
