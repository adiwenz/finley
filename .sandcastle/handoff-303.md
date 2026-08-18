# Handoff — issue 303

No declared sub-tasks in the issue; this run split the work itself along the two liquidation
paths the issue's "Where it comes from" section names.

**Done so far (this commit):**
- Added `Jurisdiction.earlyWithdrawalPenaltyCents?(basis, ctx)` + `WithdrawalContext` (engine
  `jurisdiction/jurisdiction.ts`, re-exported from `engine/src/index.ts`).
- Implemented it in `rules` as a flat 10% before age 59.5, gated on `category ===
  "ordinaryIncome"` (`packages/rules/src/earlyWithdrawalPenalty.ts`), wired into `usJurisdiction`
  and its `modelAssumptions` (`packages/rules/src/index.ts`).
- Wired into the RECURRING decumulation cascade (`buildWithdrawalSources`,
  `packages/engine/src/projection/withdrawal.ts`) — this alone fixes both repros in the issue
  (Repro A: retiring at 55 and drawing pre-tax before 59½; Repro B: the paycheck round-trip
  through a 401(k)).

**Remaining: the explicit funding-draw path.** The issue explicitly flags this as the same gap:
"`packages/engine/src/projection/fundingDrawStep.ts` has the same gap for an explicitly-funded
draw: a home down payment may name the pre-tax account and pays no penalty either." Not yet
touched.

## Live constraints

- **The net-vs-gross design**, established in `withdrawal.ts` and to be mirrored in
  `fundingDrawStep.ts`: the penalty is netted out of the draw IMMEDIATELY (same month), unlike
  ordinary income tax which is never netted out and settles annually. Concretely: `gross` is
  still fully sold from the account (balance moves by the full gross, basis reduction unaffected
  — income-tax treatment of the draw is completely untouched), but only `net = gross −
  penaltyCents` counts toward covering the caller's requested amount. In `buildWithdrawalSources`
  this is `need -= net` (was `need -= gross`) — the loop naturally pulls extra from the NEXT
  account in the liquidation order to make up a penalized account's shortfall, with no
  fixed-point solve and no risk of the December-recursion problem `taxYearSettlement.ts` documents
  (that problem is specific to bracket-based income tax needing the WHOLE year known first; the
  flat 10% penalty is fully known at the moment of the draw, which is exactly why it can be
  charged immediately instead of deferred to annual settlement). Apply the same idea in
  `resolveOrderedFundingDraw`: `remaining -= net` instead of `remaining -= gross`.
- **Age threading mirrors `buildRmdSources`/`RmdState`**: `WithdrawalState.personsById` was added
  as an OPTIONAL field (`readonly personsById?: ReadonlyMap<string, SimPerson>`), not required —
  several existing test helpers in `withdrawal.test.ts` build `WithdrawalState` literals without
  it, and making it required would have forced updating every one of them for no behavioral gain
  (absent → age unknown → seam never called → no penalty, which is the correct fallback anyway).
  `SimState` (used at the real call site in `simulate.ts`) already has `personsById` structurally,
  so no change was needed at that call site. Whatever field Part 2 adds to `resolveFundingDraws`'s
  or `resolveOrderedFundingDraw`'s inputs for age lookup, keep it optional for the same reason —
  `resolveOrderedFundingDraw` has several other callers (see below) that construct sources without
  a birth year in mind.
- **`WithdrawalTaxBasis.category === "ordinaryIncome"` is the ONLY signal that an account is
  pre-tax** among the four `SimAccountTaxProfile`s (`PRE_TAX_TAX_PROFILE` is the only one with
  `withdrawalCategory: "ordinaryIncome"`). The engine does not gate the seam call by category or
  age itself — it always calls `earlyWithdrawalPenaltyCents` (mirroring how
  `taxableWithdrawalCents` is always called); the jurisdiction decides applicability. Keep this
  symmetry in Part 2: call the seam unconditionally per account source, let `rules` gate it.
- `EARLY_WITHDRAWAL_ACCESS_AGE = 59.5` compared directly against the whole-year `ctx.age =
  ctx.year - birthYear` in `earlyWithdrawalPenalty.ts` — since age is always an integer, `age <
  59.5` is equivalent to `age <= 59`, which charges the FULL calendar year a household turns 59
  (the model can't see the half-birthday, so this is the conservative rounding — see the doc
  comment on `EARLY_WITHDRAWAL_ACCESS_AGE`). Keep this constant, don't reintroduce a second
  threshold elsewhere.

## Deferred (deliberate, not yet re-scoped to a task)

- **`fundingForecast.ts` / `taxYearProjection.ts`** (the year-start income-tax-installment
  pacing forecast) are NOT updated to account for the penalty's net-vs-gross effect on how much
  gross a forecast decumulation draw would need to sell. This is deliberate: the penalty doesn't
  change taxable income (only `waterfallInflowCents`/`netDeliveredCents`), so the existing
  income-tax pacing forecast's accuracy is only secondarily affected (a slightly-larger real draw
  realizes slightly more gain than forecast) and is self-correcting via the April true-up
  mechanism `taxYearSettlement.ts` already documents. Not part of either task; flag to the user
  if this ever needs tightening.
- **US exceptions are out of v1 scope on purpose** — rule of 55, SEPP/72(t), disability, first-home
  — exactly as the issue itself proposes ("A flat 10% before 59½ is the right first cut"). Do not
  add these unless a new issue asks for them; `EARLY_WITHDRAWAL_PENALTY_ASSUMPTIONS` in
  `earlyWithdrawalPenalty.ts` already discloses the simplification.

## Dead ends

- Considered charging the penalty through the SAME annual accrual/settlement pipeline income tax
  uses (`federalIncomeTax.ts` / `taxYearProjection.ts` / `taxYearSettlement.ts`), mirroring how
  RMD just adds to `ordinaryIncome` and lets the existing bracket machinery price it. Rejected:
  the penalty is a flat rate untied to brackets, needs per-SOURCE (not per-category) attribution
  since only qualifying draws are penalized while ordinary income from a job is not, and would
  have required a second full parallel accrual/installment/settlement accumulator for no benefit
  over charging it immediately — see the "Live constraints" net-vs-gross note above for what was
  built instead.
