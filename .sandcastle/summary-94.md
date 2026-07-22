# Issue #94 — Post-tax accounts: cost basis for funds + interest accrual for savings

## Overview

Post-tax accounts mishandled tax in **two independent ways** that happen to share a
file cluster. This branch fixes them as **two separate mechanisms, in two commits**, in
order — deliberately *not* collapsed into one, per the issue.

1. **Commit 1 — Funds were over-taxed.** A withdrawal from a non-liquid post-tax account
   (brokerage, goal fund) booked its **full gross** as taxable `capitalGains`, so
   principal the user already paid tax on was taxed *again* on the way out. There was no
   cost basis in the model. Now each account carries a basis and a draw books only its
   **gain** to the tax map.

2. **Commit 2 — Savings was under-taxed to zero.** The liquid cash buffer earns interest,
   taxable as **ordinary income in the year it is credited** (the 1099-INT), but the model
   credited the growth straight to the balance and never booked the tax — decades of
   compounding rode untaxed. Now `compoundAssets` records the credited interest and the
   next month's waterfall taxes it as `ordinaryIncome` through the single §5.3 seam.

The two share **one small seam** — a new optional `IncomeSourceMonth.taxableCents` that
decouples the taxable base from the cash gross — but are otherwise distinct: basis-at-
withdrawal for the funds, accrual-at-compounding for cash.

---

## RGR Verification Details

### Commit 1 (cost basis)
- **RED.** Added four unit tests in `withdrawal.test.ts` under *"Cost basis — only the
  gain of a fund withdrawal is taxable"*. Reverting the gain logic (`gainOf(draw) => draw`,
  the old full-gross behaviour) produced **3 failures** — principal-only draws booked the
  full gross as taxable and grossed up against a tax that shouldn't exist, the
  partially-appreciated draw booked 100% gain, and basis never fell pro-rata.
- **GREEN.** With `gain = draw − draw·(basis/balance)` and pro-rata basis reduction, all
  24 withdrawal tests pass; the pre-tax path is unchanged (basis 0 → gain == gross).

### Commit 2 (interest accrual)
- **RED.** Added two integration tests in `simulate.test.ts` under *"Savings interest is
  taxed as ordinary income at accrual"*. Disabling `buildSavingsInterestSources` made the
  interest-taxing test **fail** (month 2 tax stayed at the wage-only $300 instead of rising
  as the credited interest was taxed); the 0%-return control still passed, isolating the
  interest as the cause.
- **GREEN.** With the zero-gross interest source routed into the next month's waterfall,
  both tests pass: month 1 taxes wages only (accrual lag), months 2+ tax wages + interest,
  and the buffer keeps growing while never being withdrawn.

---

## Key Decisions & Why

### Commit 1 — cost basis
- **Basis lives on `SimState` (`basisByAccount`), not on `SimAccount`.** It is per-account
  *mutable* state that parallels `assetBalances` in shape and lifecycle, matching the
  existing `deferredByPersonYear` accumulator pattern. `SimAccount` is the immutable
  compiled config; basis changes every month, so it belongs with the balances.
- **Pro-rata gain, not specific-lot.** `gain = draw − draw·(basis/balance)`; basis falls by
  the principal returned, so a later draw's gain fraction tracks the basis that remains.
  The gain fraction is **constant in the draw**, which is what keeps the #100 gross-up
  climb monotone — the fixed-point sizing loop is untouched, it just sees a smaller
  taxable base.
- **Pre-tax accounts no-op naturally, no special-case in the draw path.** A
  `contributionsPreTax` account opens at basis 0 and takes no deposit basis, so
  `gain == gross` falls straight out of the same formula. The only profile checks live in
  basis *maintenance* (init, deposits, transfers), where they are legitimate: pre-tax
  contributions genuinely have no basis.
- **Opening basis == opening balance** for post-tax accounts (the friendly default: assume
  no embedded gain), 0 for pre-tax. Documented cost: it understates tax for a user
  modelling an already-appreciated portfolio.
- **Basis survives the whole lifecycle:** rises with post-tax deposits (surplus sweep, goal
  funding — never pre-tax deferrals/match), falls pro-rata on withdrawal, drains to 0 on
  `spend`/`convertToEquity`, and stays coherent through one-time transfers (proportional
  moves scale it, fixed outflows return it pro-rata, post-tax influx adds to it).
- **`taxableCents` decouples taxable base from cash.** The full gross is still paid out as
  take-home; only `taxableCents` (the gain) is booked to the per-category tax map. The
  waterfall's `applyDeferrals` and the withdrawal's `estimateNetIncome` both honour it.

### Commit 2 — interest accrual
- **Accrual, not withdrawal, and not the "cheap" version.** The issue explicitly warns
  against routing the savings draw through the withdrawal seam — that lands near-correct by
  accident and spreads the over-taxation defect onto savings. The withdrawal path stays
  tax-free (savings is `TAX_EXEMPT`, correct since f350aa5); the bug was untaxed *accrual*.
- **Same seam, no second tax call site.** Commit 1's `taxableCents` is reused: a **zero-
  gross** source (`grossCents` 0, `taxableCents` = credited interest) books the interest as
  `ordinaryIncome` without re-injecting cash the balance already holds. It flows through the
  one §5.3 `computeTaxCents` chokepoint like every other taxable flow.
- **One-month accrual lag by construction.** `compoundAssets` (step 9) runs *after* the
  waterfall tax seam (steps 3–6), so a month's credited interest can only be taxed in the
  next month's seam. `savingsInterestAccruedCents` carries it forward, overwritten every
  month so it never goes stale. A same-month tax would be circular (the interest depends on
  the post-waterfall balance). The lag is consistent with the model's existing documented
  year-boundary simplifications (GH #34).
- **Booked as a non-withdrawal source**, so it shrinks the decumulation gap and lands in the
  §5.4 provisional-income formula — interest is ordinary income, so it can pull a government
  benefit into taxability (the amplification the original issue described; right sign,
  corrected mechanism and magnitude).
- **Keyed on the liquid buffer** — the cash account by definition in this model. 100% of a
  cash return is currently-taxable interest, so no basis is involved: the credited growth
  *is* the taxable amount.

---

## Changes Made

### Commit 1 — `79cc1f8`
- **`waterfall.ts`** — added optional `IncomeSourceMonth.taxableCents`; `applyDeferrals` now
  books `taxableCents ?? grossCents` (minus any deferral) to the per-category tax map.
- **`withdrawal.ts`** — `WithdrawalState` gains `basisByAccount`; the draw loop computes the
  pro-rata `gainOf(draw)`, books only the gain to the taxable map, reduces basis by the
  principal returned, and stamps `taxableCents` on each injected source. `estimateNetIncome`
  honours `taxableCents` so the gross-up baseline matches the seam.
- **`simulate.ts`** — `SimState` gains `basisByAccount`; initialised (opening balance for
  post-tax, 0 for pre-tax); deposits add basis for non-pre-tax accounts; `fireGoalDispositions`
  drains basis to 0 with the balance; `applyAssetTransfers` keeps basis coherent.
- **`withdrawal.test.ts`** (+4 tests), **`retirementView.test.ts`** (state literal updated).

### Commit 2 — `33c3462`
- **`simulate.ts`** — `SimState` gains `savingsInterestAccruedCents`; `compoundAssets`
  records the liquid buffer's credited interest per owner; new `buildSavingsInterestSources`
  emits the zero-gross `ordinaryIncome` source into the next month's `nonWithdrawalSources`.
- **`simulate.test.ts`** (+2 tests).

---

## Verification & Testing

- `npm run check` (purity + typecheck + full test) — **green**.
  - Engine purity check passed.
  - `tsc --noEmit` clean across the workspace.
  - **639 tests passed | 45 todo (684)** across 54 test files.
- Baseline before this work was **394** engine tests / **637** workspace tests; this branch
  adds **6** new tests (+4 cost-basis, +2 interest-accrual) with **zero regressions**.
- Both RED states were reproduced by reverting each commit's core logic (3 failures for
  Commit 1's gain logic; 1 failure for Commit 2's interest source), then restored to green.

### Acceptance criteria
- **Commit 1:** a brokerage/goal-fund principal-only draw (basis == balance) books **$0**
  taxable; a draw after growth books **only the gain**; pre-tax draws are **unchanged**
  (still fully taxable). ✓
- **Commit 2:** retirement/earning months **no longer report $0 tax** while savings grows;
  tax appears in the (next) month the interest is credited, **not** only once savings is
  drawn; a plan that **never withdraws** savings still pays tax on its interest. ✓
