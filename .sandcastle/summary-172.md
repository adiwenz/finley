# Slice #1 — Retire the scalar `planExpense` path

## Overview

The `Plan` model carried a scalar general-expense lever (`expenseCents`) plus an
`expenseOverrides` array that the projection base compiled into a single "planExpense"
expense series whenever a plan authored no budget lines. That path was already inert
everywhere — every shipped plan and preset also set a non-empty line-item budget, which took
over wholesale — so it was dead weight that Slice #3's `FinancialObligation` would otherwise
inherit only to delete.

This change deletes the scalar path outright. Line-item **budget lines are now the single
expense authoring surface**: the projection base sources general expenses only from compiled
budget lines, and an absent/empty budget simply contributes no general spending (health and
event-created costs still apply). No projection output changes, because every real plan already
drove spending through its budget lines.

## RGR Verification Details

**RED** — Added two tests to `projectionBase.test.ts` asserting general expenses come only from
budget lines:
- With the sample plan, every general-expense series is tagged `budgetLine`.
- With an empty budget, only the `healthcare` series remains.

Against the old code both failed, surfacing the scalar series:
```
expected [ 'planExpense', 'healthcare' ] to deeply equal [ 'healthcare' ]
```

**GREEN** — Removed the scalar `SimCashFlowSeries` construction from `createProjectionBase`
(expenses now flow through `compileExpenseBudgetLines` only), deleted `expenseCents` /
`expenseOverrides` / `ValueOverride` from the `Plan` model, dropped the `planExpense`
`SpendingSourceKind`, and gave both engine fixtures a single literal spend line matching their
former scalar amount. Both tests pass; the whole suite stays green.

A brief wrong turn: replacing the read-model's untagged fallback with a hard `throw` broke ~44
engine-internal tests that legitimately build raw, provenance-less expense series (the
`spendingSource` field is type-optional). Reverted to a graceful fallback under a new neutral
`"untracked"` provenance kind — never produced by the plan→projection pipeline, only by
low-level series that bypass the compilers.

## Key Decisions & Why

- **Budget lines are the only expense surface, and `budgetLines` is REQUIRED.** A plan always
  states its spend, even when that statement is "nothing": `budgetLines: []` is the deliberate
  no-general-spending plan, rather than a missing field standing in for it or a scalar to fall
  back to. Fixtures and defaults now express spend as one literal line, which inflates with CPI
  exactly as the old scalar series did — so the default net-worth curve and headline retirement
  age are byte-for-byte unchanged (pinned by the template-total and retirement tests).
- **`planExpense` → `untracked`, not deleted entirely.** The unified spending read model still
  needs a provenance for raw expense series that carry no authoring home (engine-internal /
  test series). Renaming to `untracked` removes the scalar-fallback terminology while keeping
  the sum invariant (`Σ spendingItems == expenses + liability payments`) intact for those
  series. It never arises from a real plan.
- **Presets author their budgets as lines.** Each teaching scenario now names a written-out
  budget const (`MODEST_BUDGET`, `LEAN_BUDGET`, `COMFORTABLE_BUDGET`) that `teachingPlan` takes
  as an argument, rather than a scalar spend expanded into scaled lines — no scalar lever
  survives in the app either. The SUM is still the tuned number, pinned by an independent
  expected-spend map in the test. Sam and Jordan share `MODEST_BUDGET`: same household, different
  paycheck, which is the point of the pair.
- **Debug panel reports the budget-line total.** The old "Expenses (general)" / "Expense
  overrides" rows read the removed scalar fields; they now show the summed base amount and
  count of literal expense budget lines.

## Changes Made

**Engine**
- `plan.ts` — removed `expenseCents`, `expenseOverrides`, and the now-unused `ValueOverride`
  interface + `OverrideScope` import; updated the health and `budgetLines` doc comments.
- `projectionBase.ts` — deleted the scalar expense-series construction and its override loop;
  general expenses now come solely from `compileExpenseBudgetLines`.
- `projection/spendingItems.ts` — dropped the `planExpense` source kind; added the neutral
  `untracked` kind and renamed the untagged fallback (`UNTAGGED` → `UNTRACKED`).
- `compileBudget.ts`, `index.ts`, `ledger/household.ts`, `projection/simulate.types.ts`,
  `projection/buildHouseholdInput.ts` — removed scalar/`expenseCents` terminology from comments.
- `testing/samplePlan.ts` — both fixtures (`samplePlan`, `baristaPlan`) now carry a single
  literal spend line via a shared `spendLine` helper (exported for tests).

**App**
- `planDefaults.ts` — dropped the scalar fields; the default plan opens on the template budget
  lines only.
- `presets.ts` — `teachingPlan(budgetLines, over)`; each scenario declares a written-out budget
  const. Deleted `scaledBudgetLines` and its rounding-residue logic.
- `components/baseAdjustments/budgetTemplate.ts`, `components/baseAdjustments/baseAdjustmentsPanel.tsx`,
  `components/budgetEditor/budgetEditor.tsx` — comment updates.
- `components/debugPanel/debugPanel.tsx` — new `expenseLinesSummary` helper drives the
  budget-line total + count rows.

**Tests**
- `projectionBase.test.ts` — new "expenses come only from budget lines" block; `saver` /
  `nearCoverage` health fixtures now use budget lines.
- `compileBudget.test.ts` — removed the two scalar-path equivalence tests; added an
  empty-budget-spends-nothing test.
- `projection/spendingItems.test.ts`, `projectionRoot.test.ts` — fixture/label updates for the
  sample plan now carrying a spend line.
- `presets.test.ts`, `mainState.test.tsx`, `goalsView.test.ts`, `retirementView.test.ts`,
  `components/baseAdjustments/budgetTemplate.test.ts` — derive spend from budget lines instead
  of the removed scalar field.

## Verification & Testing

- `npm run check:purity` — engine purity passed.
- `npm run typecheck` — clean.
- `npm run test` — **988 tests green** (45 todo), 83 files.
- `npm run check` — green end to end.

No `planExpense` or scalar-fallback terminology remains in code or comments (the only surviving
`expenseCents` is an unrelated local variable in `simulate.ts`; "scalar" survives only in the
tax module and the pre-existing income "scalar plan (no jobs)" language, both out of scope).
