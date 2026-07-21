# Issue #89 — Split the derived Liability shapes into term loan vs revolving card

## Overview

A liability is genuinely one of two things — a **term loan** that amortizes over a
fixed term, or a **revolving card** with a credit limit that never amortizes. The
engine modelled both derived shapes with one type carrying two optional/nullable
fields (`termMonths?` / `creditLimitCents?`), so every consumer re-derived which kind
it held and each shape could represent states that cannot exist (a card with a term, a
loan with a limit, a liability with neither).

The persisted boundary (`LoanEvent`, `TakeLoanInput`) was already a discriminated union
on `kind`. This change pushes that same correctness into the **derived** shapes, exactly
per the issue's scoped table:

| shape | action taken |
|---|---|
| `SimLiability` | **Split into two classes** — `AmortizingLoan` / `RevolvingCard` off a shared abstract base, with a polymorphic `monthlyPaymentCents(balance, month)`. |
| `LiabilityDef` | **Union on `kind`**, mirroring `LoanEvent`. |
| `HouseholdLiability` | **Union on `kind`.** |
| `ReportLiability` | **Left flat** — the debug-export JSON shape is byte-for-byte unchanged. |

The kind-check that had leaked into three places in the sim loop is deleted:
`isCreditCard()`, the sentinel-`0` `computeFixedPaymentCents()`, the
`!isCreditCard() && termMonths !== null` double-guard, and the `isCreditCard()`
min-payment-vs-schedule branch are all gone.

## RGR Verification Details

- **RED** — Added `AmortizingLoan / RevolvingCard split` tests to
  `packages/engine/src/liability.test.ts` asserting the two new classes and their
  polymorphic `monthlyPaymentCents`. Run showed `TypeError: AmortizingLoan is not a
  constructor` (7 failures) — the classes did not yet exist.
- **GREEN** — Rewrote the class section of `liability.ts` into an abstract
  `SimLiabilityBase` + two concrete subclasses + a `SimLiability` union alias. The new
  tests passed and the pre-existing amortization / min-payment / transfer tests stayed
  green.
- **REFACTOR** — Threaded the split through every consumer (unions on `LiabilityDef` /
  `HouseholdLiability`, construction sites in `buildHouseholdInput` / `simulate`,
  handler in `eventHandlers`, mapping in `interpret`, and the flat-DTO serialization in
  `report`). Collapsed `computeLiabilityPayments` to a single polymorphic call and
  deleted the now-unused `SimState.amortSchedules` precompute entirely (the schedule now
  lives inside `AmortizingLoan`).

## Key Decisions & Why

- **Abstract base + union alias, not a bare union.** `SimLiabilityBase` holds the
  shared identity/balance/transfers machinery and declares the abstract
  `monthlyPaymentCents` seam; `AmortizingLoan` and `RevolvingCard` are the concrete
  arms; `type SimLiability = AmortizingLoan | RevolvingCard` is what the heterogeneous
  sim list is typed as. This gives the sim loop one polymorphic call and lets both
  `instanceof` and `kind` narrow cleanly.
- **Amortization schedule moved into `AmortizingLoan`.** It is computed once in the
  constructor from opening balance/rate/term — identical inputs to the old
  `initSimState` precompute — so behaviour is unchanged, but the `SimState.amortSchedules`
  map and the `simulate.ts:194` double-guard that populated it are deleted, not
  relocated (AC).
- **`monthlyPaymentCents` caps at payoff internally.** Both arms compute
  `owedWithInterestCents` (a shared protected helper) and `Math.min` against it, so a
  small balance is never over-charged — the exact semantics the old branch had, now
  polymorphic.
- **`RevolvingCard.creditLimitCents` stays `Cents | null`.** `null` = unbounded is a
  *legitimate* card state the §5.1 cascade already relies on; it is intrinsic to the
  card, not a bridging default. The impossible states (card-with-term, loan-with-limit)
  are what the split removes.
- **No new `?? null` / `!== null` at the sim boundary.** `buildHouseholdInput` now
  branches on `def.kind` and constructs each subclass from exactly the fields its kind
  carries — no optional-field juggling. The synthetic shortfall card is a plain
  `new RevolvingCard({...})` with a finite limit.
- **`ReportLiability` untouched.** The flat DTO (`termMonths: number | null`,
  `creditLimitCents: Cents | null`) is a greppable wire format the debug export echoes
  verbatim. The report builder now derives those nulls with `instanceof` at the
  serialization boundary, so the exported JSON shape does not move.

## Changes Made

- **`packages/engine/src/liability.ts`** — Replaced `class SimLiability` with abstract
  `SimLiabilityBase` (shared fields, transfers, abstract `monthlyPaymentCents`,
  protected `owedWithInterestCents`), concrete `AmortizingLoan` (required `termMonths`,
  origination-time amortization schedule, schedule-lookup payment) and `RevolvingCard`
  (`creditLimitCents: Cents | null`, min-payment). Added `export type SimLiability =
  AmortizingLoan | RevolvingCard`. Removed `isCreditCard()` and
  `computeFixedPaymentCents()`.
- **`packages/engine/src/projection/simulate.ts`** — Synthetic card is a
  `new RevolvingCard`; `cascadeCards` filters by `instanceof RevolvingCard` (typed
  `readonly RevolvingCard[]`); deleted the `amortSchedules` precompute and the
  `SimState.amortSchedules` field; `computeLiabilityPayments` collapsed to a single
  `liab.monthlyPaymentCents(bal, month)` call — the double-guard and the min-vs-schedule
  branch are gone.
- **`packages/engine/src/projection/buildHouseholdInput.ts`** — Constructs
  `RevolvingCard` / `AmortizingLoan` per `def.kind`.
- **`packages/engine/src/ledger/interpretState.ts`** — `LiabilityDef` is now a
  discriminated union on `kind` (`LiabilityDefCommon` + two arms).
- **`packages/engine/src/ledger/household.ts`** — `HouseholdLiability` is now a
  discriminated union on `kind`.
- **`packages/engine/src/ledger/interpret.ts`** — Maps `LiabilityDef` →
  `HouseholdLiability` preserving the discriminant per arm.
- **`packages/engine/src/ledger/eventHandlers.ts`** — `loan.apply` builds the correct
  `LiabilityDef` arm from the discriminated `LoanEvent`.
- **`packages/engine/src/projection/report.ts`** — Serializes the flat DTO with
  `instanceof`-derived nulls; JSON shape unchanged.
- **`packages/engine/src/liability.test.ts`** / **`simulate.test.ts`** — Updated
  construction sites to the two new classes; added split-behaviour coverage.

## Verification & Testing

- `npm run check` (purity guard + typecheck + full suite): **all green**.
- `npm run typecheck`: clean.
- Test suite: **518 passed | 45 todo (563)** across 44 test files, including the
  `debugExport` round-trip test — confirming the exported report JSON shape is
  unchanged.
