# Slice 4 — Line-item budget + amount sources + spans/overrides (issue #67)

## Overview

Introduces the **line-item budget** authoring model that will eventually replace
the scalar `Plan.expenseCents` / `retirementDeferralPct%` / `surplusSwept` triad
(§12/§15/§18/§19 of `JOBS_HOUSEHOLD_REDESIGN.md`). A budget is now a **prioritized
list of dollar line items** — general expenses and dollar contributions to named
accounts — each carrying an explicit **amount source** `{ literal, fill-to-limit,
goal-paced }` and optional **time-variation** (spans + dated value overrides).

Per the redesign's migration strategy the work lands **additively**: the new model
compiles into the *existing* `LedgerBaseConfig → interpretLedger → simulateHousehold`
pipeline, sitting alongside the scalar path (which is removed only at the #72 hinge).
No existing behaviour changed; the whole suite stays green.

Key facts ride on the **target account's kind**, never hardcoded per line (§12):
* **pre/post-tax treatment** is *derived* from the account kind (AC5);
* the **annual cap** a `fill-to-limit` line tracks comes through the
  **rules/jurisdiction seam** — auto-following the legislated age-50 catch-up bump
  with no user edit (AC3), consuming #33's caps via `retirementDeferralLimitCents`.

## RGR Verification Details

* **RED** — `budgetLine.test.ts` was written first against a not-yet-existing
  `./budgetLine` module; `vitest` reported `Failed to load url ./budgetLine … Does
  the file exist?` (suite failed to load — the canonical red state for a new module).
* **GREEN** — implemented `budgetLine.ts` (types + pure resolver); the first test
  (`literal` source) passed, then the suite was grown to 21 tests covering every
  amount source, spans, overrides, pre/post-tax derivation, and priority ordering.
* Compilation (`compileBudget.ts`) and the `Plan.budgetLines` wiring were driven the
  same way: unit tests on the compiled series, then an **end-to-end** pass through
  the real simulator (`createProjectionBase → replayLedger`) proving the line-item
  budget actually moves net worth (spend-more-ends-poorer, span-that-stops-early-ends-richer),
  not a stub.
* AC3's "uses #33's caps via the rules seam" is proven in `packages/rules` against
  the **real** `retirementDeferralLimitCents` (base limit, age-50 catch-up, and the
  60–63 SECURE 2.0 super-catch-up), not a mock.

## Key Decisions & Why

* **Pure types + one resolver, sim seam isolated.** `budgetLine.ts` imports nothing
  from `projection/*` (mirrors `job.ts`); the simulator/jurisdiction dependency lives
  in `compileBudget.ts` (mirrors `compilePerson.ts`). Keeps the authoring model free
  of import cycles and the engine-purity guard green.
* **`fill-to-limit` reads the cap through the jurisdiction interface, never imports
  rules.** `ResolveLineContext.annualLimitCents(ctx)` *is* the seam; `fillToLimitSeamFor(jurisdiction)`
  bridges `Jurisdiction.retirementDeferralLimitCents` into it. The catch-up bump lives
  entirely inside that rules-side function, so the *same* authored line resolves to a
  higher amount from age 50 with zero authoring change. No seam → no cap → resolves 0
  (nothing to fill) rather than inventing a number.
* **`fill-to-limit` spreads the annual cap evenly across the year** (`round(cap/12)`).
  The cap is an *annual* legislated figure; monthly is the natural sim granularity.
* **`goal-paced` = remaining-gap ÷ months-left** (`round(max(0,target−balance)/(targetMonth−month))`),
  re-pacing off the live balance and stopping at the deadline / once met. This is the
  #26 deadline-paced sinking-fund *primitive*; the full #26 pacing computation wires in
  slice 6, so only the amount-source variant + its pacing shape land here.
* **Overrides mirror `SimCashFlowSeries` semantics** (a `thisMonthOnly` at the exact
  month wins; otherwise the latest `fromHereForward` on/before the month stands), so the
  authoring model and the compiled series agree — and the §19 "catch-up as an explicit
  dated dollar bump" alternative to `fill-to-limit` falls out for free.
* **Priority = explicit `priority` else category-tier default** (`needs < wants <
  savings`), stable within a tier (§15). Order is descriptive + a default source, but
  overridable — it only bites in a shortfall.
* **Additive compilation.** `createProjectionBase` compiles the budget's *expense*
  lines into `initialExpenseSeries` (spans → series start/exclusive-end, overrides →
  series edits) **only when `Plan.budgetLines` is non-empty**; otherwise the scalar
  `expenseCents` series is untouched. This keeps every existing app/engine test
  trustworthy.

## Changes Made

* **`packages/engine/src/budgetLine.ts`** (new) — the standing model:
  `AccountKind`, `TaxTreatment`, `BudgetTarget`, `AmountSource`, `BudgetCategory`,
  `BudgetLineSpan`, `BudgetLineOverride`, `BudgetLine`, `ResolveLineContext`,
  `ResolvedBudgetLine`; and the pure functions `taxTreatmentForAccountKind`,
  `taxTreatmentForLine`, `resolveBudgetLineMonthlyCents`, `orderBudgetLines`,
  `resolveBudget` (the §13/§Q27 prioritized per-line funded view).
* **`packages/engine/src/compileBudget.ts`** (new) — `compileExpenseBudgetLines`
  (expense lines → `SimOwnedSeries[]`, refusing non-literal expense sources) and
  `fillToLimitSeamFor` (the jurisdiction→resolver cap bridge).
* **`packages/engine/src/projectionBase.ts`** — additive branch: compile
  `budget.budgetLines` expense lines in place of the scalar expense series when present.
* **`packages/engine/src/plan.ts`** — added optional `Plan.budgetLines?: readonly BudgetLine[]`.
* **`packages/engine/src/index.ts`** — barrel-exports the new types + functions.
* **`packages/engine/src/budgetLine.test.ts`** (new) — 21 tests (resolver, sources,
  spans, overrides, tax treatment, ordering, resolveBudget).
* **`packages/engine/src/compileBudget.test.ts`** (new) — 11 tests (compiled series,
  seam bridge, end-to-end sim wiring).
* **`packages/rules/src/budgetFillToLimit.test.ts`** (new) — 4 tests: `fill-to-limit`
  against the **real** US caps incl. age-50 + 60–63 catch-ups (AC3 seam integration).

## Acceptance Criteria

* ✅ Budget is a prioritized list of dollar line items (expenses + contributions).
* ✅ `literal`, `fill-to-limit`, `goal-paced` all resolve through one resolver path.
* ✅ `fill-to-limit` tracks the legislated limit incl. the age-50 catch-up via the
  rules seam, with no user edit.
* ✅ Line items support spans and dated value overrides.
* ✅ Pre/post-tax treatment is derived from the target account kind.

## Verification & Testing

* `npm run check:purity` → **engine purity passed** (no rules/app import; the cap
  arrives only through the jurisdiction interface).
* `npm run typecheck` → **clean**.
* `npm run test` → **461 passed | 45 todo (506) across 41 files** — **0 regressions**.
  New coverage: 21 (`budgetLine`) + 11 (`compileBudget`) + 4 (`rules` fill-to-limit) = 36.

## Notes for the next iteration

* **Contribution lines are resolved but not yet *deposited* by the simulator.**
  `resolveBudget` produces the prioritized, per-line funded view (with pre/post-tax
  tagging) that the §5.0 waterfall will consume, and expense lines flow end-to-end
  today. A generic *dollar contribution to an account* channel (pre-tax deferral by
  dollar amount + post-tax priority deposits) is a waterfall extension — the fixed
  §5.0 waterfall currently exposes only fractional deferrals, target-based goals, and
  surplus. Wiring dollar contributions into the waterfall (and retiring `expenseCents`
  / `deferralPct` / `surplusSwept`) is the **#72 hinge**; this slice deliberately stops
  at the additive model + resolver + expense compilation to keep the branch green.
* `goal-paced`'s full #26 pacing (asap handling, deadline semantics) lands in slice 6.
* `AccountKind` currently lives on the budget line's target. When the authoring
  `Account` model (#68) grows a granular kind field, the line should read the kind off
  the referenced account rather than restating it, closing the §12 "limits ride on the
  account" loop fully.
