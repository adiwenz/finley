# Summary — Issue #301: Annual federal income tax, paid on a smooth monthly schedule

## Overview

Federal income tax was modeled as a monthly withholding approximation: each month's taxable
income was annualized (×12), taxed, and divided by 12, and any taxable funding draw (a home
purchase's down payment, a one-time spend, an ordinary decumulation withdrawal) was **grossed
up** — sold for more than requested so the induced tax came out of the sale itself. Both
mechanisms mispriced lumpy income: a January RMD, taxed as if it recurred all year, produced
large early charges and negative monthly "refunds" afterwards.

Federal income tax is now genuinely **annual in liability** and **monthly in payment**:

1. At each tax year's first processed month, the simulator prices the year's estimated
   liability off the taxable income it already knows is scheduled — wages, pensions,
   government benefits, that year's RMD — and charges an even twelfth of it through the
   ordinary allocation waterfall every month.
2. Actual taxable income keeps accumulating all year, including endogenous taxable
   withdrawals no estimate could predict.
3. December (or the last processed month, if a funding block truncates the year) prices the
   year's **actual** total and charges or refunds only `actualAnnualTax − taxPaidYTD`.

Recursive gross-up survives in exactly one place: the December reconciliation, when paying the
remaining bill requires a taxable withdrawal that enlarges the very bill it's funding.

## The two taxable-income figures

The distinction the whole design rests on:

| | Projected KNOWN annual taxable income | ACTUAL accumulated annual taxable income |
| --- | --- | --- |
| Where | `SimState.estimatedFederalTaxByPersonYear` (via `taxYearProjection.ts`) | `SimState.taxableIncomeByPersonYear` |
| Built from | the compiled income series, the benefit builder, and the year's RMD — read forward, never from year-to-date | every taxable dollar as it actually occurs |
| Used for | pacing twelve even estimated payments | the authoritative December liability |
| Contains endogenous withdrawals | no — unknowable at the year's start | yes |

The inclusion test is **knowable, not recurring**: can the taxable amount be read off compiled
state at the year's start without executing the stateful monthly waterfall? A one-month bonus
compiles to a single month of a salary series, so it is as knowable as the eleven around it and
is estimated like them. A funding withdrawal — decumulation, a home purchase's down payment, a
one-time spend — is not: `resolveOrderedFundingDraw` splits it across accounts by their balance
and cost basis in the month it lands, both products of that year's returns, earlier draws and
tax already paid, and a draw that shorts out blocks and realizes nothing. Pricing that at year
start would be a second simulation of the year, so it is left to December.

Already-simulated months are never mutated when the two diverge; the difference lands in
December.

## Key decisions

- **`federalIncomeTax.ts` is the shared abstraction.** `annualFederalTax` is the single
  entry point both payers price through, so `actualAnnualTax − taxPaidYTD` is a difference of
  two comparable figures rather than two unrelated tax computations.
  `monthlyInstallmentCents` uses cumulative rounding, so twelve instalments sum to the annual
  figure to the exact cent and December's reconciliation is never a rounding residue.
- **The projection reads the compiled series, not event types.** `projectKnownTaxYear` folds
  the year's first month's REAL `nonWithdrawalSources` (which is where the year's RMD and any
  accrued interest enter) plus `buildIncomeSources`/`buildGovernmentBenefitSources` for the
  remaining eleven months. No `isRmd`/`isBonus`/`isOneOff` special cases exist; the benefit
  builder runs against shadow copies of its two caches so pricing a future month never
  advances the real run's markers.
- **Deferral semantics are shared, not duplicated.** `deferralForSourceCents` /
  `taxableAfterDeferralCents` are extracted from the waterfall's own `applyDeferrals` and
  reused by the projection, so an estimate can never be sized off a taxable base the actual
  month will not book. `remainingDeferralRoomCents` is likewise shared.
- **The engine owns payment timing; the waterfall owns nothing about tax.**
  `WaterfallInput.estimatedIncomeTaxCents` hands the waterfall a FIXED per-person scalar it
  deducts from take-home. The waterfall never prices tax — it sees one month, and the
  liability is annual.
- **Decumulation sizes its gap net of the instalment.** `buildWithdrawalSources` subtracts the
  month's estimated tax from non-withdrawal income; otherwise exactly the instalment would go
  uncovered every month, pushing a thin-buffer household onto credit rather than its own
  investments.
- **A refund is a single event.** A negative reconciliation credits the household's liquid
  account once, in the settling month, and is reported as that month's negative `taxCents`.
  Earlier months are never rewritten.
- **The estimate costs less than a simulated month.** One pass over the compiled series for the
  year's remaining eleven months, once a year — no replay of the waterfall, no fixed-point loop.
  A projection is still exactly one `simulateHousehold` call, so the retirement solver's binary
  search costs what it always did.
- **Attribution splits same-month from display.** The monthly instalment really does come out
  of take-home, so it haircuts each source's `netCashFlowCents`; December's settlement is
  raised by selling assets, so it rides only the display map the tax chart bands on. Over a
  year the two together sum, per source and per category, to the actual annual tax.

## Changes

- `projection/federalIncomeTax.ts` **(new)** — annual pricing, the even-twelfth schedule,
  and the running per-person payment record.
- `projection/taxYearProjection.ts` **(new)** — projected known annual taxable income.
- `projection/annualTaxSettlement.ts` — now a RECONCILIATION: nets the year's actual liability
  against payments made, refunds an overshoot, and keeps the recursive gross-up for a bill that
  must be funded by a taxable sale.
- `projection/waterfall.ts` / `.types.ts` — shared deferral helpers; `computeTakeHome` deducts
  the caller-supplied instalment.
- `projection/allocationStep.ts` — charges the instalment, records it against the year, and
  owns its category/source splits; exports `remainingDeferralRoomCents`.
- `projection/withdrawal.ts` — gap sized net of the instalment.
- `projection/runState.ts` — `estimatedFederalTaxByPersonYear`, `federalTaxPaidByPersonYear`.
- `projection/simulate.ts` — prices the year once, pays it monthly, reconciles at year end.
- `projection/assumptions.ts` — discloses the estimate/reconcile timing to the user.
- `jurisdiction/jurisdiction.ts`, `rules/src/index.ts` — the ANNUAL contract now documents both
  calls (scheduled income for the estimate, actual income for the reconciliation).

## Verification

`npm run check` (engine-purity + typecheck + full suite) is green: **138 test files, 1856
tests passing, 45 todo, 0 failures**.

`rules/src/federalIncomeTaxSchedule.test.ts` **(new)** runs the schedule end to end through
`Projection` under the real US brackets: over each of three years the charged tax equals
`usJurisdiction.computeTaxCents(the year's actual reported income)` to the cent, with eleven
level instalments and the year's savings interest settled in December. The engine's own suite
adds the same equality under a neutral bracketed fixture — flat-rate fixtures alone cannot show
it, since a flat year's tax is linear in income and reconciles by arithmetic.

`projection/federalIncomeTax.test.ts` (renamed from `annualTaxSettlement.test.ts`) covers, all
through `simulateHousehold`: even monthly payments for steady wages; a known annual RMD spread
across the year rather than spiked; a one-month bonus folded into the year's estimate rather
than reconciled; lumpy-vs-even scheduled income producing the identical estimate; a home
purchase's and a one-time spend's funding draw neither grossed up nor estimated, but present in
actual annual income and settled in December; no YTD extrapolation and no monthly refunds; a
fresh tax year each January; an
endogenous withdrawal enlarging December alone while earlier months stay byte-identical; the
year's total charge equalling the annual tax on actual taxable income; recursive gross-up
converging to its closed form; a single refund for an overshooting estimate; a block-truncated
year settling where it stops; per-category reconciliation on every month; and the instalment
arithmetic's cent-exactness. A projection-level regression test pins the intended graph
behaviour directly: three years of steady income, every month's tax equal, and net worth
strictly increasing month over month — no December sawtooth.

Home-purchase and one-time-spend coverage (no gross-up, gain still included in the year's
actual taxable income) was already in place and passes unchanged. Payroll-tax behaviour is
untouched and its tests pass unmodified.
