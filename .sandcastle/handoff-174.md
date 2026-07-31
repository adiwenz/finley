# Handoff — issue 174

**Done so far:** Tasks 1–3. Task 1 (define `FinancialObligation` + the two named sums),
task 2 (construct the obligation list from every source), task 3 (resolve priority at
construction + carry it through budget-line compilation). Tasks 4–6 remain.

`buildObligations(expenseSeries, month, liabilities, payments)` in
`packages/engine/src/projection/financialObligation.ts` mirrors `buildSpendingItems`
(`projection/spendingItems.ts`) input-for-input and is **still not consumed** — the simulator
builds and reports `SpendingItem`. The two coexist until task 5 retires the old term. Output is
byte-for-byte unchanged.

## Live constraints
- **The two sums must stay two functions.** `automaticFundingTotal` splits on
  `funding.kind === "automatic"`; `expenseReportingTotal` splits on `treatment === "expense"`.
  Never collapse them (pinned by `financialObligation.test.ts`). They only *coincide* while no
  obligation is `funding: explicit` (this slice); explicit funding (Slice #4) diverges them.
- **Do not inline a `.reduce` over obligations at any call site** (AC). When tasks 4/5 wire
  obligations in, route every total through one of the two named functions.
- **Amounts are requested/owed, nominal at `month`.** A debt obligation's `amountCents` is the
  payoff-capped payment already in the `payments` map — do not recompute or re-cap it.
- **Treatment axis:** liability payments are `treatment: "debt-payment"`, not `expense`, so they
  fund (via `automaticFundingTotal`) but stay out of `expenseReportingTotal`.
- **`buildObligations` tracks `buildSpendingItems` exactly** until task 5 deletes the latter:
  same id shape, dormant-series-reported-at-0 rule, UNTRACKED fallback. Derived totals must equal
  `flows.expensesCents + flows.liabilityPaymentsCents` (== `sumSpendingItems`). `expensesCents`
  EXCLUDES debt, so `expenseReportingTotal` maps to it and `automaticFundingTotal` maps to the
  full funded amount; they differ by the debt over a real month.
- **`index.ts` is re-export-only** (guarded by `index.guard.test.ts`). `buildObligations` and
  `OBLIGATION_PRIORITY` are internal (like `buildSpendingItems`) — NOT exported there.
- **Priority now resolved (task 3), still NOT consumed.** `OBLIGATION_PRIORITY`
  (`financialObligation.ts`) = `{ mandatory: -1000, needs: 0, untracked: 3000 }`. In
  `buildObligations`: liabilities → `mandatory`; each expense source →
  `source.priority ?? DEFAULT_PRIORITY_BY_KIND[kind]` (budgetLine/healthcare/event → needs,
  untracked → untracked tier). Budget lines carry `budgetLinePriority(line)` from
  `compileBudget.ts`; court-ordered event streams (alimony, childSupport) carry `mandatory` from
  `interpret.ts` (`COURT_ORDERED_ROLES`) — a child's cost shares the `event` kind but stays a
  need, so kind alone can't tell them apart. **`SpendingSource.priority?` is the carrier field**
  added in `spendingItems.ts`; it moves/renames with the type in task 5.
- **Tie-break is the stable `id`.** When task 4 sorts the waterfall input by priority it MUST
  break ties on `id` (constant across months) or chart bands reshuffle month-to-month. Task 3
  only resolved the numbers; the sort itself is task 4's to add.

## Dead ends
- (none yet)

## Deferred
- **`funding: explicit` branch** — defined, unused until Slice #4. Do not build against it.
- **Task 4** wires the inversion: construct obligations BEFORE decumulation sizing and make the
  waterfall's input a derivation of the list (sorted by priority, ties on `id`), proving output
  is byte-for-byte unchanged.
- **Task 5** retires `SpendingItem`: swap the flow record's array for the obligation list, derive
  `lineMonthlyCents` from the same list in one pass, amend the reporting header comment, delete
  `SpendingItem`/`SpendingSource`/`SpendingSourceKind`/`SpendingCategory` and the now-duplicated
  `LIABILITY_LABEL`/UNTRACKED in `spendingItems.ts`. `financialObligation.ts` imports
  `SpendingSource` (now carrying `priority?`) from `spendingItems.ts` — that import moves/renames
  here when the old module dies. `ObligationSourceKind`/`ObligationCategory` mirror the old
  `SpendingSourceKind`/`SpendingCategory` exactly; delete the old unions.
- **Task 6** (UI): budget editor renders every obligation, `editable` gating in-place editing.
</content>
