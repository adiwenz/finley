# Handoff — issue 265

Optimising the retirement solver. The issue body lists 7 tasks; I am doing them in order as
whole-issue mode, one commit per task. Read the issue for the full task text.

**Done so far:**
- **Task 1 — survival-only, early-exit sim path.** DONE.
- **Task 2 — skip reporting-only work during the search.** DONE (this commit).

**Remaining:** tasks 3–7 (3 = resumable core + prefix checkpoints; 4 = hoist boundary-independent
compilation; 5 = reuse solved run; 6 = memoize solve on committed state; 7 = optional
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

## Dead ends
- (none yet)

## Deferred
- (none yet)
