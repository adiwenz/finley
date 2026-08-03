# Handoff — issue 130

Whole-issue refactor (no declared tasks). I split it into parts and commit each green.

**My breakdown:**
- **Part 1 — Rename `incomeByCategory.ts` → `incomeChartData.ts` (issue §1).** DONE (this commit).
- **Part 2 — Extract `incomeChartModel.ts` from `incomeChart.tsx` (issue §2).** REMAINING. Pure prep: rows, colors, spending-need key, broke-age label, accessible summary, mode/basis band collapse. Component keeps state + Recharts JSX.
- **Part 3 — A11y output (issue §3).** REMAINING. Replace the raw-JSON `<output>` mirrors with a human-readable a11y representation (labels + formatted dollars, not ids/cents). Test-only JSON seams may stay but must be `aria-hidden`, out of the a11y tree.
- **Part 4 — Simple/Advanced control (issue §4).** REMAINING. Replace the "Advanced view" checkbox with an explicit two-mode control (radio group / segmented / `aria-pressed` toggles), visible "Simple"/"Advanced" labels, keep the `IncomeMode` union. NOTE: the "Show gross cash flows" checkbox is a SEPARATE `IncomeBasis` toggle — §4 does not touch it.
- **Part 5 — Extract `JobCard` from `jobsPanel.tsx` (issue §5).** REMAINING. Narrow callback props (§5's `JobCardProps` shape), no plan setter passed in.
- **Part 6 — Keep `JobForm` cohesive (issue §6).** Likely NO-OP; `jobForm.tsx` already uses one draft object and derives open-ended from `endAge === null`. Just don't split it.
- **Part 7 — Don't broaden `BaseAdjustmentsPanel` (issue §7).** Constraint, not work. Only touch its imports if the income extraction requires it.

## Live constraints
- **Behavioral refactor only** — no change to income values, source ordering, Simple/Advanced output, spending-need, insolvency/shortfall, chart click, or any job/pay behavior. The existing tests are the guard.
- **Test seams currently consumed by `baseAdjustmentsPanel.test.tsx` and `mainState.test.tsx`:** `data-testid` `income-first-row`, `income-bands`, `income-summary`, `income-first-spending-need`, `income-second-spending-need`. Keep these working (Part 3 may move them under `aria-hidden`/`data-testid` but must not delete them without updating those tests). `mainState.test.tsx:209` reads `income-second-spending-need`.
- **§4 will break `baseAdjustmentsPanel.test.tsx:225`** (`getByRole("checkbox", { name: /Advanced view/i })`) — update that test to the new control when Part 4 lands. `Show gross cash flows` checkbox at line 240 stays a checkbox.
- No `useMemo` added purely for the refactor (issue §2 explicit). The existing `useMemo`s in `incomeChart.tsx` predate this work and stay.

## Dead ends
- (none yet)

## Deferred
- (none yet)
