# Handoff — issue 174

**Done so far:** Task 1 (define `FinancialObligation` and the two named sums). Tasks 2–6 remain.

New: `packages/engine/src/projection/financialObligation.ts` (+`.test.ts`), exported from `index.ts`. `SpendingItem` (`projection/spendingItems.ts`) is untouched and still drives everything — the two coexist until task 5 retires the old term.

## Live constraints
- **The two sums must stay two functions.** `automaticFundingTotal` splits on `funding.kind === "automatic"`; `expenseReportingTotal` splits on `treatment === "expense"`. They are NOT the same reduce and must never be collapsed — the tests pin each predicate independently. They only *coincide* while no obligation is `funding: explicit` (this slice); explicit funding (Slice #4) makes them diverge permanently.
- **Do not inline a `.reduce` over obligations at any call site** (AC). When tasks 2/4/5 wire obligations in, route every total through one of these two named functions.
- **Amounts are requested/owed, nominal at `month`** — a debt obligation's `amountCents` is the payoff-capped payment (capped by the debt, not by affordability). Actual charged amount is Slice #5's `ResolvedFunding`, not this type.
- **Treatment axis carries real meaning already:** only `treatment: "expense"` counts as an expense. `debt-payment` and `asset-acquisition` are funded (in `automaticFundingTotal`) but excluded from `expenseReportingTotal`. Construct debt payments as `debt-payment`, not `expense`.
- **The old invariant to preserve (task 4/5):** today `sumSpendingItems === flows.expensesCents + flows.liabilityPaymentsCents === totalSpendingCents` (see `projection/spendingItems.test.ts`). Note today's `expensesCents` already EXCLUDES debt (debt is `liabilityPaymentsCents`), so when wiring: the reporting/expense total maps to `expenseReportingTotal` and the full funded amount maps to `automaticFundingTotal` — they differ by the debt amount over a real month. Reconcile which consumer takes which sum in task 4 while proving projection output is byte-for-byte unchanged.
- **`index.ts` is a re-export-only map** guarded by `index.guard.test.ts` — only add `export type { … } from "…"` lines, never declarations or `export *`.

## Dead ends
- (none yet)

## Deferred
- **`funding: explicit` branch** is defined but unused — Slice #4 (task 4 wires the inversion; explicit funding itself is a later slice). Do not build against it yet.
- **`priority`** field exists on the type but is currently always hand-set in tests; task 3 resolves it from source kind (debt first, court-ordered alongside, healthcare/child in needs tier, budget lines by existing category ordering, ties broken by a stable key) and carries priority through budget-line compilation (`compileBudget.ts` currently drops it — rewrite that comment).
- **`ObligationSourceKind` / `ObligationCategory`** mirror the old `SpendingSourceKind` / `SpendingCategory` exactly. When task 5 retires `SpendingItem`, delete the old unions rather than leaving both.
