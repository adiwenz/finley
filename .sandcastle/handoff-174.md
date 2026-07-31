# Handoff — issue 174

**Done so far:** Tasks 1–4. Task 1 (define `FinancialObligation` + the two named sums),
task 2 (construct the obligation list from every source), task 3 (resolve priority at
construction + carry it through budget-line compilation), task 4 (invert the dataflow —
obligations are built before decumulation and the waterfall's input derives from the list).
Tasks 5–6 remain.

Task 4 wired `buildObligations` into `simulate.ts` (`simulateHousehold`): the list is now built
right after `payments`/`totalPaymentsCents`, and `automaticFundingTotal(obligations)`
(`automaticFundingCents`) feeds BOTH decumulation sizing (`buildWithdrawalSources`) and the
allocation waterfall (`allocateMonth`), replacing the old parallel `expenseCents +
totalPaymentsCents` at those two call sites. Output is byte-for-byte unchanged (769 engine /
1265 total tests green) because `automaticFundingCents === expenseCents + totalPaymentsCents`
in this slice — see the invariant below.

`buildSpendingItems` (`projection/spendingItems.ts`) STILL builds the reporting list and the
flow record; `buildObligations` and it now coexist, one driving the waterfall, one reporting.
Task 5 retires the old term and unifies them.

## Live constraints
- **`automaticFundingCents === expenseCents + totalPaymentsCents`** is what keeps output
  unchanged. It holds because every obligation this slice is `funding: automatic`, expense-series
  obligations sum to `expenseCents`, and liability obligations sum to `totalPaymentsCents`
  (`payments` values > 0; a 0 payment is skipped by `buildObligations` but adds 0 to the scalar).
  Guarded end-to-end by `withdrawal.test.ts` → "sizes decumulation against expenses PLUS debt".
  Breaking it (e.g. sizing the waterfall off `expenseReportingTotal`, which EXCLUDES debt) is a
  defect, not a rebaseline.
- **`expenseCents` and `totalPaymentsCents` scalars now feed ONLY `buildFlows`** (the reporting
  side). Task 5 owns replacing them: `buildFlows`'s expense arg → `expenseReportingTotal(obligations)`,
  its liability-payments arg → `automaticFundingCents − expenseReportingTotal(obligations)` (i.e.
  the non-expense obligations) — route through the named sums, never a fresh `.reduce`. Deleting
  `sumMonthlySeries`/`expenseCents`/`totalPaymentsCents` is safe once `buildFlows` derives from the
  list; keep `automaticFundingCents` for the waterfall.
- **The two sums must stay two functions.** `automaticFundingTotal` splits on
  `funding.kind === "automatic"`; `expenseReportingTotal` splits on `treatment === "expense"`.
  Never collapse them (pinned by `financialObligation.test.ts`). They only *coincide* while no
  obligation is `funding: explicit` (this slice); explicit funding (Slice #4) diverges them.
- **Do not inline a `.reduce` over obligations at any call site** (AC). Route every total through
  one of the two named functions.
- **Amounts are requested/owed, nominal at `month`.** A debt obligation's `amountCents` is the
  payoff-capped payment already in the `payments` map — do not recompute or re-cap it.
- **Treatment axis:** liability payments are `treatment: "debt-payment"`, not `expense`, so they
  fund (via `automaticFundingTotal`) but stay out of `expenseReportingTotal`. `expensesCents`
  EXCLUDES debt; `automaticFundingTotal` is the full funded amount; they differ by the debt.
- **`buildObligations` construction point is order-safe.** It reads `state.liabilities` (roster,
  unchanged by `advanceLiabilities` — only balances move) and the already-fixed `payments` map,
  so it yields the identical list whether built before decumulation (task 4) or after the
  liability step (where `buildSpendingItems` runs today). Task 5 can drop `buildSpendingItems` and
  read the obligation list built at task 4's point.
- **`buildObligations` order is source-order, NOT priority-order.** Expense series first (input
  order), then liabilities (roster order) — see `financialObligation.test.ts` assertions that pin
  `[mortgage, auto, studentLoan, card]` and `[alimony, childSupport]`. Do NOT sort inside
  `buildObligations`; sorting it by priority reorders those and breaks the tests.
- **`index.ts` is re-export-only** (guarded by `index.guard.test.ts`). `buildObligations`,
  `automaticFundingTotal`, `OBLIGATION_PRIORITY` are internal — NOT exported there.
- **Priority (`OBLIGATION_PRIORITY = { mandatory: -1000, needs: 0, untracked: 3000 }`)** is
  resolved on each obligation but STILL not consumed for ordering — the waterfall input is an
  order-invariant sum. The priority sort with **ties on the stable `id`** belongs where an ordered
  list is actually read: the flow-record chart bands, task 5's territory (chart bands reshuffle
  month-to-month without the id tie-break). Task 4 deliberately added no sort — there was no
  consumer for one and sorting `buildObligations` would break its order tests (above).

## Dead ends
- (none yet)

## Deferred
- **`funding: explicit` branch** — defined, unused until Slice #4. Do not build against it.
- **Task 5** retires `SpendingItem`: swap the flow record's array for the obligation list, derive
  `lineMonthlyCents` from the same list in one pass, route `buildFlows`'s expense/liability args
  through the named sums (above), sort the reported list by priority with ties on `id` (chart
  bands), amend the reporting header comment (claims its output is never consumed), delete
  `SpendingItem`/`SpendingSource`/`SpendingSourceKind`/`SpendingCategory` and the duplicated
  `LIABILITY_LABEL`/`UNTRACKED`/`buildSpendingItems`/`sumSpendingItems` in `spendingItems.ts`.
  `financialObligation.ts` imports `SpendingSource` (carrying `priority?`) from `spendingItems.ts`
  — that type moves/renames into `financialObligation.ts` when the old module dies.
  `ObligationSourceKind`/`ObligationCategory` mirror the old `SpendingSourceKind`/`SpendingCategory`
  exactly; delete the old unions.
- **Task 6** (UI): budget editor renders every obligation for the month, `editable` gating in-place
  editing; non-editable rows deep-link to their real edit surface.
