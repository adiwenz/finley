# Issue #53 — Real US federal tax tables for a SINGLE FILER (in `rules`)

## Overview

`#50` built the neutral, category-aware `computeTaxCents` seam but left the `US-2026`
jurisdiction returning **0** for every category. This issue fills in the real
single-filer policy, entirely inside `packages/rules` (no engine change, preserving
the `#50` neutrality invariant — no US tax constants in `packages/engine/src`).

The new `packages/rules/src/federalTax.ts` implements the four things that make US
federal tax not-a-flat-rate for a single filer, and wires the monthly seam into
`usJurisdiction`:

1. **Progressive ordinary brackets** — `wages` + `ordinaryIncome` (plus the taxable
   slice of the government benefit) climb the 10 → 37 % bracket stack.
2. **Standard deduction** — a flat exclusion off ordinary income first, with any
   unused remainder stacking *down* onto capital gains.
3. **Capital-gains preference** — `capitalGains` taxed at the preferential 0/15/20 %
   rates, **stacked on top of** ordinary taxable income (so a high ordinary income
   pushes gains out of the 0 % band).
4. **Government-benefit inclusion** — only a portion of a `governmentRetirement-
   Benefit` (US: Social Security) is taxable, set by the provisional-income formula
   (0 % / ≤50 % / ≤85 %). `taxExempt` income is never taxed but **does** count toward
   provisional income, so it can pull the benefit into the taxable range.

Filing status is fixed to **single** here. The tax-unit grouping and MFJ/MFS/HoH
tables are `#52`, which builds a status parameter on top of this module.

## RGR Verification Details

- **RED:** wrote `packages/rules/src/federalTax.test.ts` (15 cases pinning the base-year
  tables, the bracket/standard-deduction math, capital-gains stacking across the 0 %
  band, the three-tier Social-Security inclusion formula, tax-exempt-into-provisional,
  and the monthly seam's annualize→tax→÷12 behavior). First run failed to even load —
  `Error: Failed to load url ./federalTax … Does the file exist?` — the expected RED.
- **GREEN:** added `federalTax.ts` implementing `federalTaxTables`,
  `taxableSocialSecurityCents`, `federalAnnualTaxCents`, and the monthly seam
  `computeFederalTaxCents`. Test file went 15/15 green.
- **Wire-in + regression:** pointed `usJurisdiction.computeTaxCents` at the real seam.
  Three `app` acceptance tests (for `#28`, `#37`, `#66`) legitimately shifted — real
  tax trims the default $5k plan's surplus, lifting its feasible retirement floor from
  63 to the Social-Security age (67). Updated those three to restore their *intent*
  under real tax (headroom so the behavior under test — disposition delta / pinned-age
  100 % / expense-pushes-later — is observable), with comments explaining the shift.

## Key Decisions & Why

- **Monthly seam, annual brackets.** The engine calls `computeTaxCents` **once per
  person per month** with monthly slices (`waterfall.ts` accumulation and
  `withdrawal.ts` marginal differencing). Brackets are annual, so the seam annualizes
  the slice (×12), runs the annual math, and returns the month's 1/12 share — the
  standard steady-state withholding approximation. The pure annual entry point
  (`federalAnnualTaxCents`) is tested directly for cent-exact bracket math.
- **Correct stacking order.** Standard deduction stacks *down* (ordinary first,
  remainder onto gains); capital gains stack *up* (fill the 0/15/20 % bands above
  ordinary taxable income). This is the real IRS Qualified-Dividends-and-Capital-Gain
  worksheet behavior and the only way the 0 % band and the benefit interaction come out
  right.
- **Social-Security thresholds are NOT indexed.** The $25,000 / $34,000 provisional-
  income thresholds are fixed in statute (since 1984/1993) and deliberately held flat
  across all years — unlike the brackets/deduction/cap-gains tops, which index forward.
  `taxExempt` is folded into provisional income (never taxed, still counts).
- **Base-year pinning + forward indexing, mirroring the sibling modules.** Pinned to
  `FEDERAL_TAX_BASE_YEAR = 2026`; a shared `indexForward` (same shape as
  `contributionLimits` / `healthCosts`) returns the base unchanged at/before 2026 (so
  the cent-pinned anchors stay exact) and indexes later years down-rounded to $50 (kept
  monotonic). Rates never move — only the dollar thresholds.
- **Neutrality preserved.** Every US constant lives in `rules`; the engine was not
  touched. `check:purity` still passes.

## Changes Made

- **`packages/rules/src/federalTax.ts`** (new) — the single-filer tax engine:
  - `FEDERAL_TAX_BASE_YEAR`, `federalTaxTables(year)` + `FederalTaxTables`/`OrdinaryBracket`
    types (indexed brackets, standard deduction, cap-gains bracket tops).
  - `taxableSocialSecurityCents(benefit, otherProvisional)` — three-tier inclusion.
  - `federalAnnualTaxCents(annualByCategory, year)` — pure annual orchestration
    (inclusion → deduction → ordinary brackets → cap-gains preference).
  - `computeFederalTaxCents(monthlyByCategory, year)` — the monthly engine seam
    (annualize → tax → ÷12).
- **`packages/rules/src/federalTax.test.ts`** (new) — 15 unit tests (RED→GREEN).
- **`packages/rules/src/index.ts`** — replaced the zero-returning `computeUsTaxCents`
  placeholder; `usJurisdiction.computeTaxCents` now delegates to
  `computeFederalTaxCents(taxableByCategory, ctx.year)`; re-exported the new public API.
- **`packages/rules/src/index.test.ts`** — refreshed the placeholder assertion (now
  documents the monthly seam) and added a real-tax end-to-end case ($100k/yr → $13,170
  annual tax through the monthly seam).
- **`packages/app/src/retirementView.test.ts`** — updated three acceptance tests whose
  pinned ages shifted once real tax lands (see RGR above); intent preserved, comments
  added.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — ✓ engine purity (no US constants / no rules import in engine).
- `npx vitest run` — **534 passed | 45 todo (579)**, 45 files. Baseline was 518 passed;
  +15 `federalTax` cases +1 new `index` case = 534.
- `npm run check` (purity + typecheck + test) — exit 0.
