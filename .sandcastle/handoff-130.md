# Handoff — issue 130

Whole-issue refactor (no declared tasks). I split it into parts and commit each green.

**My breakdown:**
- **Part 1 — Rename `incomeByCategory.ts` → `incomeChartData.ts` (issue §1).** DONE (this commit).
- **Part 2 — Extract `incomeChartModel.ts` from `incomeChart.tsx` (issue §2).** DONE. `buildIncomeChartModel(data, {mode, basis, personNames, currentAge})` → `{ bands (id+label+color), rows (render-ready Recharts data), spendingNeedKey, lastX, brokeMonth, brokeAgeLabel, gapSummary, accessibleSummary }`. Component now owns only mode/basis state, click gesture, Recharts JSX. Model unit-tested in `incomeChartModel.test.ts`.
- **Part 3 — A11y output (issue §3).** DONE. Added a visually-hidden `<table>` (caption = accessibleSummary; rows = source label + formatted dollars, total income, spending need) as the real nonvisual representation. `role="img"` now wraps ONLY the Recharts chart (was wrapping the whole panel incl. controls). Test-only JSON `<output>` mirrors kept but stay `hidden` (out of a11y tree). Model gained `accessibleSources`/`accessibleTotalIncome`/`accessibleSpendingNeed`. New `incomeChart.test.tsx` covers it.
- **Part 4 — Simple/Advanced control (issue §4).** DONE. Replaced the "Advanced view" checkbox with a two-radio `<fieldset>` ("Chart detail: Simple / Advanced"). `mode` stays the `IncomeMode` union. "Show gross cash flows" is still a separate `IncomeBasis` checkbox, untouched. Tests: `incomeChart.test.tsx` uses `getByRole("radio")`; `baseAdjustmentsPanel.test.tsx:225` updated to the radio.
- **Part 5 — Extract `JobCard` from `jobsPanel.tsx` (issue §5).** REMAINING. Narrow callback props (§5's `JobCardProps` shape), no plan setter passed in.
- **Part 6 — Keep `JobForm` cohesive (issue §6).** Likely NO-OP; `jobForm.tsx` already uses one draft object and derives open-ended from `endAge === null`. Just don't split it.
- **Part 7 — Don't broaden `BaseAdjustmentsPanel` (issue §7).** Constraint, not work. Only touch its imports if the income extraction requires it.

## Live constraints
- **Behavioral refactor only** — no change to income values, source ordering, Simple/Advanced output, spending-need, insolvency/shortfall, chart click, or any job/pay behavior. The existing tests are the guard.
- **Test seams currently consumed by `baseAdjustmentsPanel.test.tsx` and `mainState.test.tsx`:** `data-testid` `income-first-row`, `income-bands`, `income-summary`, `income-first-spending-need`, `income-second-spending-need`. Keep these working (Part 3 may move them under `aria-hidden`/`data-testid` but must not delete them without updating those tests). `mainState.test.tsx:209` reads `income-second-spending-need`.
- `Show gross cash flows` checkbox stays a checkbox (separate `IncomeBasis` toggle).
- No `useMemo` added purely for the refactor (issue §2 explicit). The existing `useMemo` in `incomeChart.tsx` (now wrapping `buildIncomeChartModel`) predates this work and stays.
- **`income-first-row` seam now shows CLAMPED band cents** (rebuilt from `model.rows[0]`), was unclamped `view.rows[0].centsBySource`. Tests still pass (default plan has no negative first-row band). Part 3 redesigns this seam entirely — replace the raw-JSON `<output>` reduce in `incomeChart.tsx` with the human-readable a11y representation and keep a clean test-only seam.

## Dead ends
- (none yet)

## Deferred
- (none yet)
