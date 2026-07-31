# Handoff — issue 174

**Done so far:** Tasks 1–5. Task 1 (define `FinancialObligation` + the two named sums),
task 2 (construct the list from every source), task 3 (resolve priority at construction +
carry it through budget-line compilation), task 4 (invert the dataflow — obligations built
before decumulation, waterfall input derived from the list), task 5 (retire `SpendingItem`:
the obligation list is now the flow-record array, the whole `Spending*` family is deleted).
**Only task 6 (UI) remains.**

Task 5 deleted `projection/spendingItems.ts` entirely. `SpendingSource` moved into
`projection/financialObligation.ts` renamed `ObligationSource`; the `SimOwnedSeries` /
`HouseholdOwnedSeries` provenance field `spendingSource` renamed `obligationSource`. The flow
record (`ProjectionMonthFlows`) now carries `obligations: FinancialObligation[]` and
`totalObligationsCents` (was `spendingItems` / `totalSpendingCents`). `buildFlows` now takes the
obligation list in place of the old `expensesCents`/`liabilityPaymentsCents`/`spendingItems`
args and derives all three rollups from it via the named sums. `1268` tests green,
`npm run check` clean.

## Live constraints
- **`flows.obligations` is ordered by priority for reporting** — `buildFlows` calls
  `orderObligationsByPriority` (priority asc, ties on `id`) before placing the list on the
  record. This is the chart-band stacking order the UI reads. `buildObligations` itself still
  returns SOURCE order (pinned by `financialObligation.test.ts`); do NOT sort there. Task 6
  reads the already-ordered `flows.obligations` — do not re-sort or re-derive.
- **`editable` gates in-place editing (task 6's core).** True only for authored budget lines;
  everything else (`sourceKind` healthcare/event/liability/untracked) renders read-only and
  deep-links to its real edit surface — healthcare → the plan, event (child cost/alimony/child
  support) → its event, a liability payment → the loan. `sourceId` is the id to link to;
  `sourceKind` tells you which surface. `perLineBudget.ts` already reads `editable` for band
  metadata — the budget editor is the surface that must now render the full list, not just
  budget lines (`budgetEditor.tsx`).
- **The two sums stay two functions.** `automaticFundingTotal` (funding.kind === automatic)
  and `expenseReportingTotal` (treatment === expense) — never collapse (pinned by
  `financialObligation.test.ts`). They coincide only while nothing is `funding: explicit`
  (this slice). `buildFlows` derives `liabilityPaymentsCents = automaticFundingTotal −
  expenseReportingTotal` — the automatically-funded non-expenses; valid only while all funding
  is automatic (documented in `reportFlows.ts`).
- **Do not inline a `.reduce` over obligations at any call site** (AC). Route every total
  through `automaticFundingTotal` / `expenseReportingTotal` (or the pre-summed flow fields).
- **`FinancialObligation` is the only public export** (index.ts). `ObligationSource`,
  `buildObligations`, the two sums, `orderObligationsByPriority`, `OBLIGATION_PRIORITY`,
  `obligationLiabilityId` are engine-internal — NOT in index.ts (guarded by
  `index.guard.test.ts`). If task 6 needs a helper in the app, export it deliberately.
- **`amountCents` is requested/owed, nominal at `month`** — a debt's payoff-capped payment, a
  line's price-grown amount. Not what was affordable/charged (that is `ResolvedFunding`,
  Slice #5). Display it as the amount owed.

## Dead ends
- (none)

## Deferred
- **`funding: explicit` branch** — defined, unused until Slice #4. Do not build against it.
- **Task 6 (UI):** the budget editor (`packages/app/src/components/budgetEditor/`) renders
  only authored budget lines today; it must render the month's full `flows.obligations` list,
  with `editable` gating the input vs. a read-only row + deep-link (above). This is the slice's
  proof that the normalization is real. `perLineBudget.ts`/`perLineBudgetChart.tsx` already
  consume `flows.obligations` for the spending chart — reuse their band vocabulary if useful.
