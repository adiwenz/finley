# Issue #41 — Earned income before current age should be user-configurable

## Overview

Previously the engine reconstructed a person's Social-Security-covered earnings for
the years *before* "now" by deflating today's salary backwards to a **hard-coded
career start age of 18** (`CAREER_START_AGE = 18` in `projectionBase.ts`). Because
the AIME→PIA formula (§5.4) always divides by a fixed 35-year window, *when* a career
began materially changes the priced benefit — someone who started at 25 has four
fewer covered years than someone who started at 18. Assuming everyone started at 18
overstated the benefit for late starters and understated it for early ones.

This change promotes the career start age to a first-class, user-configurable
`Plan.careerStartAge` field, threaded through the earnings seeding and exposed as a
control in the Budget/Accounts panel, so the Social Security estimate is accurate.

## RGR Verification Details

**RED —** Added two engine tests to `projectionBase.test.ts` asserting that the
seeded pre-"now" earnings honour `careerStartAge` (year-count and earliest year) and
that a later career start lowers the priced SS benefit (via a `mockJurisdiction` that
prices straight off the covered record). Both failed against the hard-coded 18:

```
- 10
+ 22            // from30 still seeded 22 years (ages 18–39), ignoring careerStartAge
expected 465999328 to be greater than 465999328   // benefit identical regardless of start
```

**GREEN —** Added `Plan.careerStartAge`, replaced the `CAREER_START_AGE` constant
with `budget.careerStartAge` in `careerEarningsCents`'s two callers
(`seedPriorEarnings` and `fullCareerEarningsCents`), and seeded the field in the
fixtures/defaults. Both engine tests plus three new app-side control tests pass.

## Key Decisions & Why

- **Single source of truth, no new math.** The existing `careerEarningsCents(budget,
  startYear, fromAge, toAge)` helper already parameterised the start age — it was
  only ever *called* with the literal `18`. Making the field configurable was a
  matter of passing `budget.careerStartAge` in, so both the pre-"now" seed and the
  full-career record shift together and the graph/panel stay in agreement.
- **Field lives on `Plan`, not a separate control object.** `careerStartAge` is a
  standing household number like `currentAge`/`ssClaimingAge`, so it belongs in the
  same immutable `Plan` the projection base memoizes on.
- **UI bound `14 ≤ careerStartAge ≤ currentAge`.** A career cannot start after "now"
  (no future working years to seed), and 14 is a sane floor for covered earnings. The
  clamp reuses the existing `NumInput` blur-clamp behaviour, consistent with the
  other age controls.
- **Doc-comment invariant.** The contract `careerStartAge ≤ currentAge` (equal → no
  pre-"now" years) is documented on the field; the engine tolerates equality
  naturally because the seed loop is `[fromAge, toAge)`.

## Changes Made

- `packages/engine/src/plan.ts` — added `careerStartAge: number` to `Plan` with a
  §4.6/§5.4 doc comment explaining its effect on the AIME window.
- `packages/engine/src/projectionBase.ts` — removed the `CAREER_START_AGE = 18`
  constant; `seedPriorEarnings` and `fullCareerEarningsCents` now read
  `budget.careerStartAge`; updated the surrounding doc comments.
- `packages/engine/src/testing/samplePlan.ts` — seeded `careerStartAge: 18`.
- `packages/app/src/planDefaults.ts` — seeded `careerStartAge: 18` (default).
- `packages/app/src/components/budgetEditor/budgetEditor.tsx` — added a "Career start
  age" `NumInput` (bounded 14…currentAge) with an estimates-not-advice hint.
- `packages/app/src/goalsView.test.ts` — added `careerStartAge` to its `Plan` literal.
- Tests: `projectionBase.test.ts` (+2 engine tests), `budgetEditor.test.tsx` (+3
  control tests, +harness output).

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` → **392 tests green** | 45 todo (437 total), 36 files.
