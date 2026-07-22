# Issue #78 — On-track % computes 100% for an infeasible (insolvent) plan

## Overview

The retirement panel's **on-track %** reported **exactly 100%** for plans that are
genuinely **infeasible** (they go insolvent), producing the self-contradicting copy
*"100% of the way there — the nearest feasible age is 73."*

Root cause (`computeOnTrackFraction`, `packages/engine/src/retirementSolver.ts`): the
metric inferred the shortfall from the **most-negative real net worth** over the horizon:

```
shortfall = max(0, -min(realNetWorth));  onTrack = available / (available + shortfall)
```

But in the real-projection model failure is **insolvency**, which *nulls* net worth (§5.1)
rather than driving it negative — and phantom illiquid equity (#76) keeps solvent months
positive. So the deepest value the formula ever saw was a **positive** number → `shortfall
= 0` → `onTrack = available/available = 1.0`, regardless of feasibility.

The fix makes on-track read the **authoritative failure signal** (insolvency / negative
real net worth), never the net-worth sign, and derives a real, honest, bounded magnitude
from the **timing** of failure.

## RGR Verification Details

**RED (engine).** Added `retirementSolver.test.ts` › *"is < 1 for an infeasible plan whose
net worth stays positive to insolvency (#78)"*. It builds the issue's exact repro shape — a
`convertToEquity` home goal that locks a large fund into illiquid equity, so after
retirement the liquid drains, the plan goes insolvent, yet net worth never dips negative.
Preconditions asserted: `realNetWorthSurvives === false`, an insolvent month exists, and
every non-null real net worth is ≥ 0. With the old formula `onTrackFraction === 1.0` → test
**failed** on `expect(...).toBeLessThan(1)`.

**RED (app).** Added `retirementView.test.ts` › *"never reads 100% for an infeasible plan
and rounds the % DOWN to 0.1% (#78)"* on the default plan pinned at 65 (infeasible, feasible
floor 73). Failed because the old display used `Math.round`, giving `19` instead of the
floored `19.2`.

**GREEN.** Re-implemented `computeOnTrackFraction` to key off `firstFailureMonth` and switch
the display to floor-to-0.1%. Both new tests pass; no existing test regressed.

Verified failure timing on the repro: `firstInsolventMonth = 462`, retirement boundary
`= 192`, horizon `= 540` → `onTrack = (462-192)/(540-192+1) ≈ 0.774` (≈ 77.3%), an honest
"lasts 22 of 29 retirement years" reading instead of a meaningless 100%.

## Key Decisions & Why

- **Read failure from the signal, not the curve.** Extracted a shared `monthSurvives(m)`
  helper (`netWorthReal !== null && netWorthReal >= 0 && !isInsolvent`). Both
  `realNetWorthSurvives` and `computeOnTrackFraction` now compose it, so "what counts as
  failure" is defined once and the two can never disagree — exactly the design-note
  directive: *make failure a first-class signal for math, not something read off the curve.*

- **Magnitude = timing, not a net-worth dip.** The issue's design note explicitly rejects
  measuring a *magnitude* off the post-insolvency curve: it would be fiction (borrowing at
  22% past an exhausted credit limit → a nonsense −$3M). It also warns that a naïve
  cumulative "deficit that couldn't be financed" **compounds unboundedly** via the maxed
  synthetic card's ballooning 22% minimum payment (≈236× over a 25-year horizon), which
  would pin on-track near **0** for every insolvent plan — the same degenerate failure as
  the old 1.0, just inverted. The honest, bounded, computable quantity is **when** the plan
  fails relative to the window it needed to cover:

  ```
  onTrack = solventMonthsInRetirement / retirementWindow
          = max(0, firstFailureMonth − boundary) / (horizon − boundary + 1)
  ```

  Fails the month after retiring → ~0 ("nowhere near"); fails just short of life expectancy
  → ~0.99 ("almost there"). This is a first-order asset interpretation too — to last X×
  longer you need roughly X× the nest egg — so it stays faithful to the "% of the way
  there" framing while being fully honest.

- **Strictly < 1 by construction.** The denominator counts the window *inclusively*
  (`+ 1`), so `solventInRetirement ≤ horizon − boundary < retirementWindow`. An infeasible
  plan is therefore *never* exactly 1.0 at the source — the display can't be handed a value
  that rounds up to 100%. A pre-retirement failure clamps to 0.

- **Display floors to 0.1%.** `targetOnTrackPct` switched from `Math.round(f*100)` to
  `Math.floor(f*1000)/10`, clamped to `[0, 100]`. Rounding *down* means a plan at 99.97%
  can't round up to a reassuring "100%" it hasn't earned. Because the engine value is
  already `< 1` for infeasible plans, "never render 100% for an infeasible plan" holds
  structurally, not by a display special-case.

- **`grill-me` note.** The issue flagged the metric *definition* as an unresolved design
  decision requiring a `grill-me`. That is an interactive step; in its absence I chose the
  option the design note most strongly endorses ("how far off = *when*, an honest quantity")
  and documented the rejected alternatives (net-worth-dip magnitude; cumulative financeable
  deficit) and *why* they fail, inline and here, for the next reviewer.

## Changes Made

- **`packages/engine/src/retirementSolver.ts`**
  - New `monthSurvives(m)` — the single authoritative per-month survival/failure predicate.
  - `realNetWorthSurvives` now composes `monthSurvives`.
  - `computeOnTrackFraction` rewritten: reads `firstFailureMonth` (insolvency / negative
    real net worth) and returns the fraction of the retirement→life-expectancy window the
    plan stays solvent; strictly `< 1` for any infeasible plan, `0` if it fails at/before
    the boundary.
- **`packages/engine/src/retirementTypes.ts`** — `RetirementEvaluation.onTrackFraction` doc
  updated to the new (timing-based, failure-signal) semantics.
- **`packages/app/src/retirementView.ts`** — `targetOnTrackPct` now floors to 0.1%
  (`Math.floor(f*1000)/10`), clamped `[0,100]`; doc explains the round-down rationale.
- **`packages/engine/src/retirementSolver.test.ts`** — new #78 regression (import of
  `dollarsToCents` added).
- **`packages/app/src/retirementView.test.ts`** — new #78 display regression.
- **`packages/app/src/components/retirementPanel/retirementPanel.test.tsx`** — new render
  test asserting the panel never prints the contradictory "100% of the way there" for an
  infeasible pin and shows the honest sub-100% line with the nearest feasible age.

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` → **612 passed | 45 todo (657)**, 52 files. All new tests green; zero
  regressions.

### Scope / follow-ups

- **#76** (phantom `convertToEquity` equity) is a *separate* root cause that widens where
  this bug fires; it is intentionally **not** fixed here. This metric is now correct
  regardless of #76 because it no longer reads net worth for failure.
- The on-track metric's magnitude definition was a flagged `grill-me` decision; the chosen
  timing-based definition is documented above and inline for future revisiting.
