# Issue #150 — Disposition purge: remove `convertToEquity`/`spend`, collapse `GoalDisposition`

Part of the #129 epic (Home Purchase Funding & Goal Decoupling). This is the foundational
"clearing" slice: it removes the goal→use semantic coupling so that **a goal never moves its
own money out**. Money still leaves a goal fund through ordinary decumulation withdrawals
(every goal fund is a liquidatable source — see `withdrawal.ts` `isLiquidatable`) and, in the
#129 work, through explicit events; what's removed here is the goal *firing its own
disposition* (`spend`/`convertToEquity`) at its target month.

## Overview

`GoalDisposition` previously carried four values, two of which *fired* at a goal's target
month — `spend` (zero the fund, money leaves net worth) and `convertToEquity` (swap the
fund into an illiquid home-equity property). This slice deletes both, along with all the
firing/earmark machinery that supported them, and collapses the type to its two **purely
descriptive** members:

```ts
export type GoalDisposition = "retain" | "drawDown";
```

Nothing in the projection keys on the disposition anymore — both members leave the fund in
net worth and fully drawable in decumulation. The default plan's home goal flips
`convertToEquity → retain`, becoming a home **savings** goal with no purchase event ("a
savings goal shouldn't require a purchase").

## RGR Verification Details

- **RED:** Added `packages/app/src/planDefaults.test.ts` asserting the default plan's
  `home` goal is a `retain` savings goal (`disposition === "retain"`, `targetDate === 60`).
  It failed as expected: `expected 'convertToEquity' to be 'retain'`.
- **GREEN:** Flipped `planDefaults.ts` home goal to `retain`; the test passed.
- The engine collapse then proceeded type-first: each removal surfaced its call sites via
  `npm run typecheck`, and each referencing test was updated or (where it encoded now-removed
  behavior) rewritten to pin the new semantics, re-running the suite after each file.

## Key Decisions & Why

- **Collapse the whole firing/standing split, not just the enum values.** With no
  disposition firing, `DisposingDisposition`, `StandingDisposition`, `isDisposingDisposition`,
  and `isEarmarkedForDisposition` all became dead or constant-valued, and `GoalDisposal`
  collapsed from a discriminated union to a single `{ disposition; targetDate }` shape (both
  members now accept `"asap"`). Removing them keeps the module honest — a partial collapse
  would leave predicates that always return the same answer.
- **`isLiquidatable` loses its goal/earmark loop.** No goal fund is earmarked out of the
  drawable nest egg anymore, so the loop (and the `goals` field on `WithdrawalState`, and the
  now-dead `month` parameter it required) were removed. `buildWithdrawalSources` drops its
  `month` argument accordingly — a genuine dead-parameter removal rather than leaving it
  plumbed but unused.
- **`SimState.properties` and `SimState.goals` become `readonly`.** `fireGoalDispositions`
  was the *only* code that pushed to `properties` or reassigned `goals` mid-run; with it gone
  the run's property set and goal set are fixed at init.
- **Removed the `convertedEquityNoBasis` model-assumption disclosure.** It described the
  convertToEquity swap, which no longer happens, so surfacing it to the app would disclose a
  behavior the engine no longer has.
- **Default-plan output changes where the new semantics require it.** The home fund is now a
  drawable `retain` reserve (previously converted to illiquid equity at month 60), so it
  counts toward the nest egg. Downstream, this lowers the default plan's feasible floor
  (75 → 71) and lets a modest taxable drawdown reach Social Security in retirement (≤ $94/mo,
  vs the `taxed-in-retirement` preset's several-hundred-a-month scale). Numeric expectations
  were recomputed, not forced.

### Tests rewritten because they encoded removed behavior (rather than merely deleted)

- `withdrawal.test.ts`: the "future-dated convertToEquity fund stays earmarked" test →
  rewritten as "a goal fund at its target month is drawn — nothing earmarks or fires it."
- `simulate.allocation.test.ts`: the `spend`/`convertToEquity`/`retain` firing-at-maturity
  block → a single parametrized guard that a matured goal's fund simply stays put.
- `goal.test.ts`: the `isEarmarkedForDisposition` suite and the "firing goal always projects"
  verdict test → removed; verdict routing now keys only on target-date proximity.
- `retirementView.test.ts` / `retirementSolver.test.ts`: the convertToEquity phantom-fund
  regression guards → removed (their repro vehicle — an illiquid goal-equity holding — is no
  longer constructible from a plain `Plan`; reconstructing an equivalent via `HomePurchaseEvent`
  belongs with the #129 home-purchase work).

## Changes Made

**Engine (production)**
- `goal.ts` — collapse `GoalDisposition` to `retain | drawDown`; delete
  `isEarmarkedForDisposition`, `isDisposingDisposition`, `DisposingDisposition`,
  `StandingDisposition`; flatten `GoalDisposal` to a single object type; simplify
  `computeGoalProgress` verdict routing.
- `projection/goalSteps.ts` — **deleted** (`fireGoalDispositions`).
- `projection/simulate.ts` — remove the import and per-month `fireGoalDispositions` call.
- `projection/withdrawal.ts` — drop the earmark loop, the `goals` field, and the `month`
  parameter from `isLiquidatable`/`buildWithdrawalSources`.
- `projection/runState.ts` — `properties` and `goals` now `readonly`; docs updated.
- `projection/assumptions.ts` — remove the `convertedEquityNoBasis` disclosure.
- `plan.ts`, `projectionBase.ts`, `budgetLine.ts`, `retirementSolver.ts` — doc updates for
  the descriptive-only disposition.

**App (production)**
- `planDefaults.ts` — home goal `convertToEquity → retain`.
- `goalsView.ts` — `dispositionLabel` drops the two removed cases; `goalDisposal` simplified;
  `GoalDraft` doc updated.
- `components/goalsPanel/goalForm.tsx` — disposition picker lists `retain | drawDown`;
  default `retain`; removed the `isDisposingDisposition`-driven "asap" gating.

**Tests** — `planDefaults.test.ts` (new); updated/rewritten `goal.test.ts`,
`allocations.test.ts`, `retirementSolver.test.ts`, `projectionRoot.test.ts`,
`report.test.ts`, `projection/{withdrawal,simulate.allocation,waterfall}.test.ts`,
`goalsView.test.ts`, `retirementView.test.ts`, `presets.test.ts`,
`components/goalsPanel/goalsPanel.test.tsx`, `components/retirementPanel/retirementPanel.test.tsx`.

## Verification & Testing

`npm run check` (purity guard + `tsc --noEmit` + `vitest run`) is fully green:

```
Test Files  77 passed (77)
     Tests  900 passed | 45 todo (945)
```

(Baseline before the change was 908 passed; the net −8 is removed tests that encoded the
now-deleted firing/earmark behavior, plus one added default-plan test.)

## Notes for the next iteration

- **#76 and #57** (both about `convertToEquity` — when it fires / its equity appreciation
  rate) are now moot; close them as **superseded** by this slice.
- The retirement-solver "on-track reads insolvency, not net-worth sign" edge case previously
  reproduced via an illiquid goal-equity holding. A `HomePurchaseEvent`-based reconstruction
  of that guard is deferred to the #129 home-purchase work, where the property/event mechanism
  is the subject.
