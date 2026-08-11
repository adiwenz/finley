# Issue #231 — Remove current-income readers and 50/30/20 Quickstart

## Overview

The authoring layer carried three readers — `personMonthlyIncomeCentsOf`,
`householdMonthlyIncomeCentsOf`, `personDeferralFractionOf` — that independently recomputed "what
is a person/household earning right now" by summing every authored job's current salary, without
regard to that job's `startYear`/`endYear` span. A past job that already ended, or a future one
not yet started, counted as current income. The simulation never had this bug: it only ever pays a
job during its authored span.

This issue removes the duplicate authoring-side interpretation entirely rather than fixing its math,
per the issue's architecture note — authoring states what the user entered, the projection states
what actually happens, and debug should observe the projection's output rather than re-deriving it.
Two consumers depended on the broken readers:

1. **The 50/30/20 Quickstart** budgeting feature, which sized its tiers off the incorrect household
   income. Removed outright — the issue asked for its full deletion, not a repaired version.
2. **The debug panel's** "Income" and "Retirement deferral (blended)" rows, which now read the
   primary person's active wage sources off the same run's month-0 `ProjectionMonth.flows`, instead
   of recomputing them from authored job spans.

## RGR Verification Details

- **Engine reader removal:** `projectionFacade.reads.test.ts`'s coverage of
  `personMonthlyIncomeCents`/`householdMonthlyIncomeCents`/`personDeferralFraction` was deleted
  (tests that existed solely for the removed readers); the job-level assertions they were
  interleaved with (`jobMonthlyIncomeCents`, `jobDeferralFraction`) were kept and re-verified green,
  since those readers are untouched and still needed by "Base + Adjustments"'s pay editor.
- **Debug panel fix, red → green:** added a new `debugPanel.test.tsx` suite asserting a past job's
  pay and a future job's deferral election do not leak into the "Income"/"Retirement deferral" rows.
  Run against the pre-fix panel (still calling the just-removed facade methods) it failed with a
  runtime `TypeError`, confirming red. Implementing `primaryMonthlyIncomeCents`/
  `primaryDeferralFraction` over `ProjectionMonth.flows.incomeSources` turned it green without
  guessing the expected dollar figures: the numbers were pinned by first observing a matching
  scenario (a past-ended and a not-yet-started job alongside the active one) through
  `npx tsx repl.ts`, which confirmed the engine already omits an inactive job's source from month
  0's `incomeSources` — the fix only had to stop re-deriving that answer on the authoring side.
- **Quickstart removal:** deleted the feature's own test suites
  (`redistributeToTiers`/`tierRebalanceWrites` describe blocks in `budgetTemplate.test.ts`, the
  "rebalances to 50/30/20" test in `baseAdjustmentsPanel.test.tsx`) rather than porting them, since
  there is no replacement behavior to pin.
- Full repo gate: `npm run check` (purity + typecheck + whole-repo test) is green except one
  pre-existing, unrelated failure in `packages/engine/src/testing/comments.guard.test.ts` (asserts
  wording in `AGENTS.md`/a prompt file) — confirmed present on `origin/main` before this branch's
  changes via `git stash`, so it predates and is unrelated to this issue.

## Key Decisions & Why

- **No replacement authoring reader.** The issue is explicit that debug should observe the
  projection, not gain a corrected version of the same authoring-side computation. The fix reads
  `ProjectionMonth.flows.incomeSources`/`deferralBySourceCents` — data the engine already produces
  for the month-0 "now" snapshot — rather than adding a new authoring helper.
- **`DebugPanel` gained a `month0: ProjectionMonth` prop, not a `series: ProjectionSeries` prop.**
  The flattened `SimulationReport` (`report.months[...]`) it already receives has no per-source,
  per-owner breakdown (`incomeByCategoryCents` sums the whole household, not one person), so the
  richer `ProjectionMonth` was needed. Passing the single month it actually uses, rather than the
  whole series, keeps the prop narrow and mirrors how `report` and `series` already come off the
  same `projection.run()` call in `main.tsx` — nothing here is a second simulation.
- **Filtered by `category === "wages" && ownerId === PRIMARY_PERSON_ID`.** This is the same
  selection the old `personMonthlyIncomeCentsOf`/`personDeferralFractionOf` made (one person's job
  income, not the household's, not benefits or savings interest) — same scope, sourced from the
  simulation's own output instead of a second pass over authored jobs.
- **`primaryJobs(budget).length` was left as the job count in the "Income (N jobs)" label.** That
  count is not one of the three readers the issue names for removal, and counting authored jobs
  (rather than currently-active ones) is a reasonable, unchanged label — only the dollar/percentage
  figures beside it were wrong.
- **`toBudgetLines`/`redistributeToTiers`/`tierRebalanceWrites`/`TierRebalance` were deleted, not
  just their call sites.** They existed solely to implement the Quickstart's rebalance math; nothing
  else in the app referenced them. `defaultBudgetTemplate`/`DEFAULT_TEMPLATE_TOTAL_CENTS` were kept
  — they seed the ordinary Base budget on a fresh plan, unrelated to the 50/30/20 rebalance.
- **`plannedWorkStopAge` was dropped from `BaseAdjustmentsPanel`'s props.** Its only use was sizing
  the Quickstart's seeded savings line's end span; with the feature gone it had no remaining reader.

## Changes Made

**Engine:**
- `packages/engine/src/authoring/jobs.ts` — deleted `personMonthlyIncomeCentsOf`,
  `householdMonthlyIncomeCentsOf`, `personDeferralFractionOf`.
- `packages/engine/src/facade/projectionFacade.ts` — deleted the corresponding
  `personMonthlyIncomeCents`/`householdMonthlyIncomeCents`/`personDeferralFraction` facade methods
  and their imports.
- `packages/engine/src/facade/projectionFacade.reads.test.ts` — trimmed the two tests that covered
  the removed readers down to their still-valid job-level assertions.

**App — Quickstart removal:**
- `packages/app/src/components/baseAdjustments/budgetTemplate.ts` — deleted `toBudgetLines`,
  `redistributeToTiers`, `tierRebalanceWrites`, `TierRebalance`, and their supporting tier constants;
  kept `defaultBudgetTemplate`/`DEFAULT_TEMPLATE_TOTAL_CENTS`.
- `packages/app/src/components/baseAdjustments/budgetTemplate.test.ts` — deleted the
  `redistributeToTiers`/`tierRebalanceWrites` describe blocks.
- `packages/app/src/components/baseAdjustments/baseAdjustmentsPanel.tsx` — deleted `applyQuickstart`,
  the `retirementMonth` computation, the `plannedWorkStopAge` prop, and the
  `householdMonthlyIncomeCents` facade dependency.
- `packages/app/src/components/baseAdjustments/baseAdjustmentsPanel.test.tsx` — deleted the
  Quickstart test and the `plannedWorkStopAge` prop from both render call sites.
- `packages/app/src/components/baseAdjustments/projectionCharts.tsx` — deleted the `onQuickstart`
  prop and the "Quickstart from income (50/30/20)" button.
- `packages/app/src/main.tsx` — dropped `plannedWorkStopAge` from the `BaseAdjustmentsPanel` call.

**App — debug reads from projection output:**
- `packages/app/src/components/debugPanel/debugPanel.tsx` — added `primaryWageSourcesAt`/
  `primaryMonthlyIncomeCents`/`primaryDeferralFraction` over `ProjectionMonth.flows`; `DebugPanel`
  and `Configuration` now take a `month0: ProjectionMonth` prop instead of a `projection: PlanFigures`
  facade slice.
- `packages/app/src/components/debugPanel/debugPanel.test.tsx` — updated the render harness to pass
  `month0`; added the "current income/deferral come off the projection's month-0 output" suite
  (past-job exclusion, future-job exclusion, deferral not skewed by an inactive job).
- `packages/app/src/components/debugPanel/debugPanelDisclosure.test.tsx` — updated the render harness
  to pass `month0`.
- `packages/app/src/main.tsx` — `DebugPanel` now receives `month0={series.months[0]}` off the same
  run as `report`.

## Verification & Testing

- `npm run typecheck` — clean, whole repo.
- `npm run check:purity` — clean, no engine I/O or app/rules imports.
- `npx vitest run` (whole repo) — **1836 tests passed**, 45 todo, 1 file / 2 tests failing
  (`comments.guard.test.ts`), pre-existing on `origin/main` and unrelated to this issue.
