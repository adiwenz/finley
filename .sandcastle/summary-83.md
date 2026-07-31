# Issue #83 — Per-year covered-earnings record from jobs (SS AIME source)

## Overview

Social Security's earnings history is now built from the **same authored job compensation
the rest of the projection uses**, rather than a simplified flat-salary reconstruction. A
person's pre-"now" covered-earnings record — the historical half of the AIME input — is
compiled by evaluating each job's actual monthly compensation series and summing it per
calendar year, so mid-career raises and one-off bonuses that happened before the simulation
starts land in the record exactly as they did in life. The forward (post-"now") half already
worked this way; both halves now share one compensation model, and both the retirement panel
and the month-by-month projection consume the identical history because both build their
simulator inputs through the same `compilePerson` seam.

## Key Decisions & Why

- **Replaced the flat annual model in `compilePersonPriorEarnings`.** It previously rebuilt
  each past year's wage as `startingSalary × realGrowth × CPI` — ignoring pay changes,
  bonuses, and mid-career events. It now constructs a `SimCashFlowSeries` per job anchored at
  the job's own (possibly long-past) start month with the salary *nominal-at-that-start*,
  growing forward at real+CPI, and applies the job's pay changes and one-month overrides over
  the pre-"now" window. Evaluated at "now" this reproduces the forward series' now-salary, so
  the pre-"now" and forward records join seamlessly; evaluated backward it de-CPIs each earlier
  year, matching the old base-case values (no exact-cents regression).

- **Split cleanly at month 0.** The pre-"now" record covers only months strictly before "now";
  forward accumulation owns month 0 onward. Pay changes / overrides dated at month 0 or later
  are excluded from the historical record so the two halves never double-count a year.

- **Extracted shared helpers** (`salaryGrowthMode`, `applyPayChanges`, `applyIncomeOverrides`)
  used by BOTH the forward income series and the backward prior-earnings series, so the two
  sides apply one identical rule for growth, effective-dated raises, and bonuses — they cannot
  drift. The forward `compileJobIncome` is byte-for-byte unchanged (its 27 existing tests stay
  green); it just calls the extracted helpers.

- **Wage-base cap stays a single downstream step.** The engine folds every employer into one
  per-year figure (uncapped in the record); the rules-side AIME (`aimeCents`) caps that
  combined figure once per person per calendar year. No change was needed here — the cap was
  already applied to the summed year — but tests now pin the invariant.

- **Panel/projection consistency is structural.** Both `buildRetirementOutlook` (panel) and the
  projection build `SimPerson`s via `compilePerson`, so they share one earnings history by
  construction; `planDefaults` already documents that "the AIME→PIA seam the graph and panel
  share" has no authored override. No separate legacy earnings path existed to remove in the
  app.

## RGR Verification Details

- **RED:** Added unit tests in `job.test.ts` asserting a pre-"now" `setTo` raise and an
  `addBonus` reach the prior-earnings record. Both failed against the flat model (`expected
  7700000 to be 7200000` for the bonus; the raised year read the un-raised salary).
- **GREEN:** Rewrote `compilePersonPriorEarnings` to evaluate the actual compiled compensation;
  all six pre-"now" unit cases pass.
- **Regression net:** end-to-end tests in `projectionBase.test.ts` capture the record as the
  benefit seam first prices it (through the real projection), confirming raises, bonuses, and
  multiple concurrent employers arrive at the AIME. Rules tests in `socialSecurity.test.ts`
  pin the wage-base cap on combined multi-employer earnings and the top-35-years window.

## Changes Made

- `packages/engine/src/compilePerson.ts`
  - `compilePersonPriorEarnings` — now builds per-year covered earnings from each job's actual
    monthly compensation series (pay changes + bonuses included), months strictly before "now".
  - New `salaryGrowthMode`, `applyPayChanges`, `applyIncomeOverrides` helpers, shared with the
    forward `compileJobIncome`, which was refactored to call them (behaviour unchanged).
  - Documented the remaining partial-first-year simplification (tracked by #34).
- `packages/engine/src/job.test.ts` — new "pre-'now' covered earnings from actual compensation"
  suite: flat-salary base case, effective-dated raise, bonus, multiple concurrent jobs,
  future-dated pay change excluded from history.
- `packages/engine/src/projectionBase.test.ts` — new suite capturing the record at the benefit
  seam through a full projection: raises/bonuses included; all employers combined before any cap.
- `packages/rules/src/socialSecurity.test.ts` — wage-base cap on combined earnings (a year at
  2× cap prices identically to one at the cap); top-35-years averaging (extra lower years beyond
  35 don't dilute the AIME).

## Verification & Testing

- `npm run check` — engine purity ✓, typecheck ✓, **1298 tests green** (45 todo).
- Focused suites: `job.test.ts` (27), `projectionBase.test.ts` (31), `socialSecurity.test.ts`
  (18) all green.

## Acceptance-criteria trace

| Criterion | Where |
|---|---|
| Remove legacy flat annual income model | `compilePersonPriorEarnings` rewrite |
| Build yearly covered earnings from actual job compensation | same, + `projectionBase.test.ts` |
| Multiple concurrent jobs | `job.test.ts`, `projectionBase.test.ts` |
| Partial-year employment | forward series (existing) + monthly summation |
| Effective-dated pay changes | `applyPayChanges`, `job.test.ts` raise case |
| Covered bonuses / one-time income | `applyIncomeOverrides`, `job.test.ts` bonus case |
| Wage-base cap once per person after combining | `aimeCents` (unchanged) + `socialSecurity.test.ts` |
| Reuse existing indexed earnings → AIME → PIA | unchanged `socialSecurity.ts` seam |
| Panel and projection share the history | structural via `compilePerson`; `planDefaults` note |
| Regression tests (all listed scenarios) | the three test files above |
| Document partial-first-year discrepancy (#34) | `compilePersonPriorEarnings` doc comment |
