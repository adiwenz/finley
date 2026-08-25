# Issue #315 — RMDs as an annual minimum, not an automatic January withdrawal

## Overview

Required Minimum Distributions used to be forced in full at the start of each eligible year
(January), ahead of the household's own decumulation. That meant a household already spending
down its pre-tax accounts to cover ordinary expenses got an extra, redundant forced withdrawal on
top of what it needed. This issue changes RMDs into an **annual minimum**: the year's requirement
is priced once (in January, off the balance the year opens with, unchanged), the household's own
qualifying withdrawals accumulate against it all year, and only in **December**, after that
month's own normal withdrawal, is the shortfall (if any) forced out. Any forced excess beyond
what the month needs deposits into the ordinary post-tax cash/savings destination, exactly as
before. Nothing satisfied by an over-distribution carries into a future year.

## RGR Verification Details

- Wrote `packages/engine/src/projection/rmd.test.ts` against the target (new) behavior first,
  then confirmed it failed genuinely against the untouched implementation (12 of 20 new/changed
  cases failed — `establishRmdRequirements`/`recordQualifyingDistributions` didn't exist yet, and
  the remaining cases disagreed on WHEN the forced draw lands) before writing any implementation.
- Implemented the three-function split in `rmd.ts`, wired it into `simulate.ts`, and reran —
  all 20 cases green.
- Ran the full engine suite (86 files, 1535 tests), which was unaffected apart from one test in
  `withdrawal.test.ts` whose premise (RMD forcing at month 0) no longer holds; rewrote it to
  assert the new invariant (establishing a requirement forces nothing outside December).
- Ran the full repo suite (`npm run check` — purity guard, typecheck, full test run). One
  pre-existing pinned dollar figure in `packages/app/src/sequentialPartners.test.ts` (a 44-year
  simulation) shifted, because money that used to leave the account every January now compounds
  in place for most of the year before being forced out — a real, intended consequence of the
  behavior change, not a bug. Recomputed and re-pinned the actual figures the new (correct)
  pipeline produces.
- Final gate: `npm run check` green — 175 test files, 2917 tests passed, 0 failed.

## Key Decisions & Why

- **Split one function into three** (`establishRmdRequirements`, `recordQualifyingDistributions`,
  `buildRmdSources`) rather than threading more state through the old single pass: establishing
  the requirement (January, pricing off the balance) and forcing it (December, after decumulation)
  are now genuinely different pipeline moments, and `recordQualifyingDistributions` is the seam
  ordinary decumulation reports through without knowing anything about RMDs.
- **Eligibility is decided once, at establish time.** Once a person-year has an established
  requirement, December's true-up forces it regardless of whether that person is later gated out
  (e.g. dies) before December — preserving the existing "the year's requirement was already
  theirs, and it stands" rule, now anchored to January instead of December.
- **December's forced source is appended AFTER decumulation runs**, not before: decumulation
  sizes and sells purely off the month's real need, oblivious to any RMD; only afterward does the
  true-up compute what's still owed and inject it as additional income into that same month's
  waterfall — so it either offsets December's own credit-cascade borrowing or, once obligations
  are covered, banks straight into surplus. This is what makes "deposit excess into the normal
  post-tax destination" fall out of the existing surplus mechanism for free, with no new code.
- **Scope: only ordinary decumulation draws count as "qualifying."** An explicit one-time funding
  draw (a down payment, a one-time spend event) is a different mechanism and stays out of scope —
  the issue specifically names "normal qualifying pre-tax retirement withdrawals."
- **No balance cap surprises:** December's forced amount is capped at both
  `required − satisfied` and the account's current balance, so a person whose accounts were
  otherwise drained during the year is never forced negative.

## Changes Made

- `packages/engine/src/projection/rmd.ts` — replaced the single `buildRmdSources` pass with:
  - `establishRmdRequirements` — prices and stores each eligible person's annual requirement at
    the year's first month; withdraws nothing.
  - `recordQualifyingDistributions` — folds a month's ordinary decumulation draws from
    forced-distribution-eligible accounts into the person's year-to-date qualifying total.
  - `buildRmdSources` — December only; forces `max(0, required − satisfied)`, capped at the
    current balance, as the same `rmd:<personId>` ordinaryIncome source as before.
- `packages/engine/src/projection/runState.ts` — added `rmdRequiredByPersonYear` and
  `rmdSatisfiedByPersonYear` maps (keyed `${personId}|${year}`) to `SimState`.
- `packages/engine/src/projection/simulate.ts` — calls `establishRmdRequirements` where the old
  RMD build used to sit (ahead of decumulation), and calls `recordQualifyingDistributions` +
  `buildRmdSources` right after `buildWithdrawalSources`, folding December's true-up source into
  the same month's income before `allocateMonth` runs.
- `packages/engine/src/projection/withdrawal.ts` — updated the doc comment describing the
  interaction with RMDs (decumulation runs and is recorded BEFORE the true-up, not after a
  pre-emptive full forcing).
- `packages/engine/src/jurisdiction/jurisdiction.ts` — updated `requiredMinimumDistributionCents`'s
  doc comment to describe the annual-minimum/December-true-up contract.
- `packages/engine/src/projection/rmd.test.ts` — rewritten for the new timing; covers all four
  acceptance-criteria scenarios (fully satisfied, partially satisfied, not satisfied, satisfied by
  a December normal withdrawal), plus the existing eligibility/aggregation/death/priced-off-balance
  suites retimed to December.
- `packages/engine/src/projection/withdrawal.test.ts` — retargeted the one test whose premise
  (RMD forces at month 0) no longer applies.
- `packages/app/src/sequentialPartners.test.ts` — re-pinned one 44-year-simulation dollar figure
  that legitimately shifted (money compounds longer before being forced out).

## Verification & Testing

- `packages/engine/src/projection/rmd.test.ts`: 20/20 passing.
- Full engine suite: 86 files, 1535 tests passing (45 pre-existing todos untouched).
- `npm run check` (purity guard + typecheck + full repo test run): **175 test files, 2917 tests
  passing, 0 failed.**
