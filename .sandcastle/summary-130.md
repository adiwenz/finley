# Summary — issue 130: Refactor income chart and jobs panel component boundaries

## Overview

A structural clean-up of the income-reporting and job-authoring React files, with **no
change to user-facing behavior or financial calculations**. Two modules had grown past a
single responsibility: `incomeChart.tsx` mixed pure chart preparation with Recharts
rendering, and `jobsPanel.tsx` rendered the whole of each job inline. This branch pulls the
pure work into testable modules, gives the income chart a genuine accessible representation
and an explicit mode control, and extracts a Finley-specific `JobCard`.

Delivered in six coherent parts (the issue declared no task breakdown, so the work was split
and each part committed green):

1. **Rename** `incomeByCategory.ts` → `incomeChartData.ts` (§1) — the module builds
   income-source chart data and collapses it into Simple/Advanced views, not income by tax
   category.
2. **Extract** `incomeChartModel.ts` (§2) — all pure preparation out of the component.
3. **Accessibility output** (§3) — a human-readable nonvisual table replaces raw-JSON mirrors
   as the screen-reader representation.
4. **Mode control** (§4) — the "Advanced view" checkbox becomes an explicit two-radio group.
5. **Extract** `JobCard` (§5) from `jobsPanel.tsx` with narrow callback props.
6. **JobForm cohesion (§6)** and **no `BaseAdjustmentsPanel` rewrite (§7)** — verified as
   constraints; no code change was needed for either.

## RGR Verification Details

Each behavioral part followed red → green:

- **Model (§2):** `incomeChartModel.test.ts` asserted the model's contract (bands with colour,
  render-ready rows carrying the namespaced spending-need key, Simple-mode band collapse,
  insolvency-age formatting) against a module that did not yet exist → wrote
  `buildIncomeChartModel` → green.
- **Accessibility (§3):** new model assertions for `accessibleSources` / `accessibleTotalIncome`
  / `accessibleSpendingNeed` (formatted dollars, never ids or cents) went red, then green;
  `incomeChart.test.tsx` asserted a `role="table"` nonvisual representation and that the
  test-only JSON mirror stays `hidden` (out of the a11y tree) — red until the visually-hidden
  table was added.
- **Mode control (§4):** `incomeChart.test.tsx` was rewritten to drive `role="radio"` controls
  and assert the checked state → red against the checkbox → green after the radio fieldset.
- **JobCard (§5):** the extraction is guarded by the existing 66-test `jobsPanel.test.tsx`
  suite (the public seam), which stayed green throughout; `jobCard.test.tsx` was added as a
  characterization test of the extracted component's narrow-callback contract.

## Key Decisions & Why

- **Model returns render-ready Recharts rows.** `buildIncomeChartModel` emits rows already
  keyed for Recharts (`month` + namespaced spending-need key + clamped band cents) and bands
  carrying their own colour, so the component maps straight to `<Area>`/`<Line>` with no
  transformation. The negative-net clamp lives in exactly one place (the model); the engine and
  data model keep the honest signed figures.
- **The accessible table reads the first flowed month** — the projection's starting point —
  from the same clamped figures the bands draw, so it never quotes a value the chart doesn't.
  `role="img"` now wraps only the Recharts SVG, so the mode/basis controls sit in the a11y tree
  instead of being swallowed by the image.
- **A radio group, not a checkbox, for Simple/Advanced.** Two presentations of one union
  (`IncomeMode`) read as an explicit choice with both options named; a lone "Advanced" checkbox
  left "Simple" unnamed and implied a feature toggle. The separate "Show gross cash flows"
  basis toggle stays a checkbox — it is not part of the mode.
- **`JobCard` takes narrow callbacks, never the plan setter.** Every plan mutation leaves
  through a one-line callback (`onSaveEdit`, `onRemovePayChange`, …); which authoring panel is
  open is passed in as a per-card `authoring` slice, so only one card is ever mid-edit. The
  panel keeps list reading, add-job flow, plan coordination, and the multi-job deferral warning.
- **§6 / §7 deliberately no code.** `JobForm` already holds one draft object and derives
  open-ended from `endAge === null`; splitting it was explicitly out of scope. The income
  extraction touched `BaseAdjustmentsPanel` only through its import of `buildIncomeChartData`.

## Changes Made

- `incomeByCategory.ts` → **`incomeChartData.ts`** (+ test file rename); header rewritten. Imports
  updated in `incomeChart.tsx`, `projectionCharts.tsx`, `baseAdjustmentsPanel.tsx`.
- **`incomeChartModel.ts`** (new): `buildIncomeChartModel(data, {mode, basis, personNames,
  currentAge})` → `{ bands, rows, spendingNeedKey, lastX, brokeMonth, brokeAgeLabel, gapSummary,
  accessibleSummary, accessibleSources, accessibleTotalIncome, accessibleSpendingNeed }`. Owns
  the colour palettes, the stack clamp, and broke-age formatting.
- **`incomeChart.tsx`**: consumes the model; renders a visually-hidden data table as the
  accessible representation; `role="img"` scoped to the chart; the Simple/Advanced radio group.
- **`jobCard.tsx`** (new): the per-job `<li>` — headline, span, deferral/adjustment meta, pay
  chart, pay timeline, action buttons, and the edit/change-pay/estimate authoring surfaces.
- **`jobsPanel.tsx`**: renders `<JobCard>` per job with narrow callbacks; `describeSpan` and the
  pay-chart/timeline/form imports moved to the card.
- Tests: `incomeChartModel.test.ts` (new), `incomeChart.test.tsx` (new), `jobCard.test.tsx`
  (new); `baseAdjustmentsPanel.test.tsx` updated to the radio control.

## Verification & Testing

- `npm run typecheck` — clean.
- `node scripts/check-engine-purity.mjs` — passed.
- `npm run test` — **1591 passed, 45 todo (1636 total), 113 files.**
- The branch is green at every commit.
