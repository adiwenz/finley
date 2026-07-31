# Handoff — issue 174

**Done so far:** Task 1 (define `FinancialObligation` + the two named sums) and Task 2
(construct the obligation list from every source). Tasks 3–6 remain.

`buildObligations(expenseSeries, month, liabilities, payments)` now lives in
`packages/engine/src/projection/financialObligation.ts` (regression-tested one-per-source in
`.test.ts`). It mirrors `buildSpendingItems` (`projection/spendingItems.ts`) input-for-input and
is **not yet consumed** — the simulator still builds and reports `SpendingItem`. The two coexist
until task 5 retires the old term. Output is byte-for-byte unchanged.

## Live constraints
- **The two sums must stay two functions.** `automaticFundingTotal` splits on
  `funding.kind === "automatic"`; `expenseReportingTotal` splits on `treatment === "expense"`.
  Never collapse them — the tests pin each predicate independently. They only *coincide* while no
  obligation is `funding: explicit` (this slice); explicit funding (Slice #4) diverges them.
- **Do not inline a `.reduce` over obligations at any call site** (AC). When tasks 4/5 wire
  obligations in, route every total through one of the two named functions.
- **Amounts are requested/owed, nominal at `month`.** A debt obligation's `amountCents` is the
  payoff-capped payment already in the `payments` map — the exact figure `advanceLiabilities`
  applies, capped by the debt not affordability. Do not recompute or re-cap it.
- **Treatment axis carries real meaning:** liability payments are constructed as
  `treatment: "debt-payment"`, not `expense`, so they fund (via `automaticFundingTotal`) but stay
  out of `expenseReportingTotal`. Preserve this when wiring.
- **`buildObligations` must track `buildSpendingItems` exactly** until task 5 deletes the latter:
  same id shape (`line:<id>` for budget lines, `debt:<id>` for liabilities via
  `obligationLiabilityId`, source id verbatim otherwise), same dormant-series-reported-at-0 rule,
  same UNTRACKED fallback. When wiring, the obligation list's derived totals must equal today's
  `flows.expensesCents + flows.liabilityPaymentsCents` (== `sumSpendingItems`, pinned by
  `spendingItems.test.ts`). Note `expensesCents` already EXCLUDES debt, so
  `expenseReportingTotal` maps to it and `automaticFundingTotal` maps to the full funded amount;
  they differ by the debt over a real month.
- **`index.ts` is re-export-only** (guarded by `index.guard.test.ts`) — only `export type { … }`
  lines. `buildObligations` is internal (like `buildSpendingItems`), so it is NOT exported there.

## Dead ends
- (none yet)

## Deferred
- **`priority`** is set to a shared placeholder (`UNRESOLVED_PRIORITY = 0`) in `buildObligations`.
  Task 3 resolves it from source kind (debt first, court-ordered streams alongside, healthcare/
  child cost in the needs tier, budget lines by existing category ordering, ties broken by a
  stable key) AND carries priority through budget-line compilation (`compileBudget.ts` currently
  drops it — rewrite that comment). The obligation regression tests assert `expect.any(Number)`
  for priority so they survive task 3.
- **`funding: explicit` branch** — defined, unused until Slice #4. Do not build against it.
- **Task 4** wires the inversion: construct obligations BEFORE decumulation sizing and make the
  waterfall's input a derivation of the list, proving output is byte-for-byte unchanged.
- **Task 5** retires `SpendingItem`: swap the flow record's array for the obligation list, derive
  `lineMonthlyCents` from the same list in one pass, amend the reporting header comment, delete
  `SpendingItem`/`SpendingSource`/`SpendingSourceKind`/`SpendingCategory` and the now-duplicated
  `LIABILITY_LABEL`/UNTRACKED in `spendingItems.ts`. `financialObligation.ts` currently imports
  `SpendingSource` from `spendingItems.ts` — that import moves/renames here when the old module dies.
- **`ObligationSourceKind`/`ObligationCategory`** mirror the old `SpendingSourceKind`/
  `SpendingCategory` exactly; delete the old unions in task 5 rather than leaving both.
- **Task 6** (UI): budget editor renders every obligation, `editable` gating in-place editing.
