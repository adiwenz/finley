# Issue #97 — OASDI wage base cap + Additional Medicare Tax (payroll tax tables)

## Overview

Issue #97 is the **rate-and-threshold tables** half of payroll tax (#96 owns the engine
seam that charges it). It is pure `packages/rules` work — the tables are not blocked on #96
and land first and independently, mirroring the pattern #53 set for the income-tax tables.

Delivered a new `packages/rules/src/payrollTax.ts` module that states the US single-filer
FICA facts and the correct whole-year employee payroll tax:

- **OASDI (Social Security)** — 6.2% up to an annual per-person taxable maximum ($184,500,
  SSA 2026), nothing above it.
- **Medicare** — 1.45% on all earned income, uncapped.
- **Additional Medicare Tax** — 0.9% surtax on earned income above a fixed $200,000 statutory
  threshold (single), employee-only with no employer match.

The substantive correctness point is **indexing**: the OASDI wage base is grown at a
wage-index rate (`AWI_ANNUAL_INDEXING_RATE = 0.035`), deliberately faster than the income-tax
side's ~2.5% CPI proxy, because the cap by law tracks the national Average Wage Index. The
$200,000 surtax threshold is **never** indexed, following the frozen-in-statute precedent of
the Social-Security benefit-inclusion thresholds in `federalTaxTables.ts`.

## RGR Verification Details

Built test-first in `packages/rules/src/payrollTax.test.ts`, one vertical slice at a time:

1. **RED** — a test importing `./payrollTax` failed to resolve (module absent). **GREEN** —
   added constants + `payrollTaxTables(year)`, pinning the 2026 base-year figures exactly.
2. Added forward-indexing tests (wage base rises monotonically and outruns the CPI proxy;
   rates and the surtax threshold held flat) — passed against the `indexWageBaseForward` helper.
3. **RED** — tests for `payrollTaxParts` / `payrollTaxCents` failed on the missing exports.
   **GREEN** — implemented the three-component annual computation.
4. Added a disclosure test for `PAYROLL_TAX_ASSUMPTIONS`.

Expected values come from independent worked examples (e.g. $250k earner: OASDI capped at
`0.062 × 184,500`, Medicare `0.0145 × 250,000`, surtax `0.009 × 50,000`), not recomputed the
way the code does.

## Key Decisions & Why

- **Second indexing rate, not a CPI approximation.** The issue's recommended option: a named
  `AWI_ANNUAL_INDEXING_RATE`, distinct from the income-tax CPI rate, so the assumption is
  visible. Reusing CPI would let the cap drift progressively low and over-tax high earners — a
  compounding error over a 55-year horizon.
- **Wage base rounds DOWN to a $300 multiple.** Statute rounds to the *nearest* $300; rounding
  down instead preserves monotonic non-decreasing behaviour year over year, matching
  `federalTaxTables`'s `indexForward` idiom.
- **True combined cap (multi-job).** `payrollTaxParts` takes the person's *combined* annual
  earned income, so the wage base and surtax threshold each apply once — the amount actually
  owed on the return, not the per-employer over-withhold-then-refund cash-flow timing. Simpler
  and more accurate for planning.
- **Pure whole-year function; accumulation deferred to the engine seam.** OASDI stops mid-year
  once cumulative earnings hit the cap, so a monthly seam must *accumulate* rather than
  annualize each slice (the `deferredByPersonYear` pattern in `simulate.ts`). That accumulator
  is #96's job; this module states the correct whole-year answer the accumulator settles to,
  documented in the `payrollTaxParts` contract.
- **Assumptions exported but not wired into `usJurisdiction`.** `PAYROLL_TAX_ASSUMPTIONS` is
  ready for #96 to concatenate onto the jurisdiction once the seam charges FICA; left out of
  the live set until then so the report never discloses a tax the model is not yet applying.

## Changes Made

- **`packages/rules/src/payrollTax.ts`** (new) — `PAYROLL_TAX_BASE_YEAR`, the employee-share
  rate constants, `ADDITIONAL_MEDICARE_THRESHOLD_CENTS`, `payrollTaxTables(year)`,
  `payrollTaxParts` / `payrollTaxCents`, and `PAYROLL_TAX_ASSUMPTIONS`.
- **`packages/rules/src/payrollTax.test.ts`** (new) — 10 tests covering pinned base year,
  forward indexing, the three-component computation, cap/surtax edges, and the disclosures.
- **`packages/rules/src/index.ts`** — barrel re-exports of the new payroll surface.

## Verification & Testing

- `npm run check:purity` — engine purity intact (no US fact leaked into `packages/engine`).
- `npm run typecheck` — clean.
- `npm run test` — **1228 tests green** (45 todo), including the 10 new payroll-tax tests.
