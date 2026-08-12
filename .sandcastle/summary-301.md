# Summary — Issue #301: Settle federal income tax annually, remove event-level tax gross-up

## Overview

Federal income tax was modeled as a monthly withholding approximation: each month's taxable
income was annualized (×12), taxed, and divided by 12 (`computeFederalTaxCents`), and any
taxable funding draw (a home purchase's down payment, a one-time spend, an ordinary
decumulation withdrawal) was **grossed up** — sold for more than requested so the induced tax
came out of the sale itself. Both mechanisms mispriced lumpy income: a January RMD, taxed as
if it recurred all year, produced the sawtooth-shaped net-worth artifacts the issue names.

This branch replaces both with a true **annual settlement**: taxable income accumulates all
year, uncharged; federal income tax is computed once, on the year's actual total, and posted
as a December obligation funded through the normal waterfall. Recursive gross-up survives in
exactly one place — the December settlement itself, when paying the tax bill requires a
taxable withdrawal that enlarges the very bill it's funding.

## RGR Verification Details

Implemented via RED → GREEN across the affected modules, then REFACTOR once the shape was
right:

1. **RED** — added failing tests asserting the annual `Jurisdiction.computeTaxCents` contract
   (`packages/rules/src/index.test.ts`), confirmed failing against the old ×12÷12 wrapper.
2. **GREEN** — repurposed the seam, wired `usJurisdiction` to the pre-existing (already
   correct, already tested) `federalAnnualTaxCents`/`federalAnnualTaxByCategoryCents`.
3. Iterated the same cycle through the engine: the annual accumulator (`runState.ts`), the
   waterfall's removal of monthly charging (`waterfall.ts`/`allocationStep.ts`), gross-up
   removal (`withdrawal.ts`, `fundingDrawStep.ts`), and the new December settlement module
   (`annualTaxSettlement.ts`), each verified against the existing suite before moving on.
4. Existing tests that encoded the OLD behavior (event-level gross-up, monthly tax charges,
   per-source tax attribution) were identified via `npm run test` failures, and either
   rewritten to assert the new behavior or removed where the behavior itself no longer exists
   (e.g. per-income-source tax attribution, which has no December-settlement equivalent).
5. New tests were added for every scenario the issue's "Tests" section names explicitly (see
   Verification & Testing below), with expected values observed by running the actual engine
   (via `vitest -t`, printing intermediate state) rather than hand-derived — required for the
   recursive-settlement fixed points, which don't have closed forms once integer-cent rounding
   is involved.

## Key Decisions & Why

- **Repurposed `Jurisdiction.computeTaxCents`/`computeTaxByCategoryCents` in place**, rather
  than adding parallel `computeAnnualTaxCents` methods. An earlier attempt in this same run
  added new methods instead; that was reverted once it became clear the old monthly-slice
  contract would have zero remaining callers after the engine-side change — carrying it forward
  as a second, unused seam would have been dead API surface. One seam, annual in/annual out,
  matches the issue's own Architecture section ("Given annual taxable income/context, what is
  the annual federal income-tax liability?").
- **No new tax math in `rules`** — `federalAnnualTaxCents`/`federalAnnualTaxByCategoryCents`
  already computed the true annual liability; only the ×12÷12 monthly wrapper
  (`computeFederalTaxCents`) was deleted, since nothing needs it once the engine stops calling
  it monthly.
- **The engine no longer charges federal income tax anywhere except the December settlement.**
  `waterfall.ts`'s `computeTakeHome` now returns `gross − deferral − payrollTax` unconditionally
  (payroll/FICA tax is untouched — a structurally separate, already-annual-reconciled seam).
  `WaterfallResult.taxCents`/`taxByCategoryCents`/`taxBySourceCents` are always `0`/`{}`/`{}`
  from the ordinary waterfall; a new `taxableByPersonCents` field carries the month's uncharged
  taxable base back to the caller.
- **The annual accumulator (`SimState.taxableIncomeByPersonYear`)** mirrors the existing
  `earnedByPersonYear` pattern exactly (`${personId}|${year}` keying), so a new year gets a
  fresh entry with no explicit reset code — the same trick the codebase already uses for
  deferral/payroll accumulators.
- **`resolveOrderedFundingDraw`/`buildWithdrawalSources` sell exactly what's requested**, capped
  at the account balance, full stop — no climb, no induced-tax computation. The realized gain is
  still computed and still stacks onto the running per-owner taxable base (unchanged plumbing),
  it simply isn't netted out of the draw or charged. For funding draws specifically, the
  previously tax-routing `taxSources` net-neutral mechanism is now dead (tax is always 0), so
  the realized gain instead rides `gainSources`' `taxableCents` (previously hardcoded 0) directly
  into `allocateMonth`'s taxable pool.
- **December settlement is a dedicated module (`annualTaxSettlement.ts`), not an `automatic`
  `FinancialObligation`.** An explicit obligation's "block the whole plan on shortfall" semantics
  are right for a user-authored purchase, wrong for a system-generated tax bill — the settlement
  instead sells from each person's own accounts (their single-filer tax is priced independently),
  cash/liquid first then the ordinary liquidation order, falls back to the household's shared
  cascade cards (same ascending-APR policy as `applyShortfallCascade`) for any shortfall, and
  folds an unfundable remainder into that month's ordinary insolvency — reusing the existing
  `isInsolvent`/`uncoveredCents` machinery rather than inventing a parallel failure mode.
- **The recursive gross-up fixed point**: for one source, solving `gross = need +
  inducedTax(gross)` (the existing per-source climb pattern, reused) converges to `gross =
  Tax(base_before + gain(gross))` when `need` is re-derived as `currentBill − raisedSoFar` at
  the top of each source's processing — i.e. "sell until the sale funds the bill it just
  caused." Verified end-to-end against the real engine (not derived) in both a closed-form
  single-account case (`annualTaxSettlement.test.ts`) and two multi-account, realistic scenarios
  (`events.homePurchase.test.ts`, `events.oneTimeSpend.test.ts`).
- **Runs once per person, single-filer**, never pooled across a household — matches
  `Jurisdiction.computeTaxCents`'s existing single-filer contract, exercised the same way by the
  ordinary (now-removed) monthly charge.

## Changes Made

- `packages/engine/src/jurisdiction/jurisdiction.ts` — `computeTaxCents`/`computeTaxByCategoryCents` repurposed to an annual contract (doc-only + `nullJurisdiction` unchanged in behavior).
- `packages/rules/src/federalTax.ts`, `federalTaxAttribution.ts`, `federalTaxCore.ts` — deleted the monthly ×12÷12 wrapper (`computeFederalTaxCents`/`computeFederalTaxByCategoryCents`) and the now-dead `annualizeByCategory` helper.
- `packages/rules/src/index.ts` — `usJurisdiction.computeTaxCents`/`computeTaxByCategoryCents` wired to the annual functions.
- `packages/engine/src/projection/runState.ts` — new `taxableIncomeByPersonYear` accumulator.
- `packages/engine/src/projection/waterfall.ts`/`waterfall.types.ts` — `computeTakeHome` no longer charges income tax; new `WaterfallResult.taxableByPersonCents` output; removed the now-dead per-source income-tax attribution plumbing (`sourceTaxableByPerson`).
- `packages/engine/src/projection/allocationStep.ts` — folds `taxableByPersonCents` into the new accumulator each month.
- `packages/engine/src/projection/withdrawal.ts` — `buildWithdrawalSources` sells exactly the need, no gross-up climb; `DEFAULT_LIQUIDATION_ORDER`'s doc updated.
- `packages/engine/src/projection/fundingDrawStep.ts` — `resolveOrderedFundingDraw` sells exactly the requested amount, no gross-up climb; realized gain routes through `gainSources.taxableCents`.
- `packages/engine/src/projection/simulate.ts` — calls the new `settleAnnualTax` once per year's last processed month; folds its tax/insolvency figures into that month's report without disturbing the ordinary obligation-funding attribution math.
- `packages/engine/src/projection/annualTaxSettlement.ts` **(new)** — the December settlement: per-person recursive gross-up against the year's accumulated base, cash-first liquidation order, credit-cascade fallback, per-category reconciliation assertion.
- Test files updated across `packages/engine/src/projection/*.test.ts`, `packages/engine/src/ledger/events.{homePurchase,oneTimeSpend}.test.ts`, `packages/engine/src/facade/projectionFacade.run.test.ts`, `packages/rules/src/*.test.ts` — old gross-up/monthly-tax assertions rewritten or removed; new coverage added for the issue's acceptance scenarios.
- `packages/engine/src/projection/annualTaxSettlement.test.ts` **(new)** — dedicated coverage: lump-vs-spread parity, RMD no-immediate-charge, multi-event combination, cash-funded settlement (no uplift) vs. retirement-account-funded settlement (recursive uplift, closed-form-verified), January reset, per-category reconciliation.

## Verification & Testing

`npm run check` (purity + typecheck + full test suite) is green: **137 test files, 1843 tests
passing, 45 todo, 0 failures**, across `@finley/engine`, `@finley/rules`, and `@finley/app`.

Every scenario in the issue's "Tests" section is covered:
- same annual taxable income → same annual tax regardless of month (`annualTaxSettlement.test.ts`)
- a large January RMD causes no immediate tax payment (`annualTaxSettlement.test.ts`)
- annual federal tax is charged in December (`annualTaxSettlement.test.ts`, `events.homePurchase.test.ts`)
- a home-purchase / one-time-spend taxable withdrawal is exactly the amount needed, no gross-up (`events.homePurchase.test.ts`, `events.oneTimeSpend.test.ts`)
- those withdrawals' taxable income is included in the year's accumulator (same two files)
- multiple taxable events combine into one annual base (`annualTaxSettlement.test.ts`)
- a bill payable from cash needs no additional taxable withdrawal (`annualTaxSettlement.test.ts`)
- a bill funded from a taxable retirement account correctly grosses itself up until fully funded (`annualTaxSettlement.test.ts`, and organically in `events.homePurchase.test.ts`/`events.oneTimeSpend.test.ts`)
- January begins a fresh accumulator (`annualTaxSettlement.test.ts`)
- payroll-tax behavior is unchanged (pre-existing payroll tests pass unmodified)
- annual tax attribution reconciles exactly to the scalar liability (`annualTaxSettlement.test.ts`, runtime-enforced via `assertPersonTaxBreakdownReconciles`)
