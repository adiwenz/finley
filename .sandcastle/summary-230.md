# Issue #230 — Starting balance of all accounts

## Overview

A fresh plan's three standing accounts — cash, retirement, brokerage — were not
symmetric: only cash (`Plan.openingBalanceCents`) had a user-editable starting balance.
Retirement and brokerage were hardcoded to open at $0 in `buildPlanAccounts`
(`packages/engine/src/compile/projectionBase.ts`), with no field on `Plan` and no
control in the UI to change that. A user who already had retirement or brokerage
savings before starting the simulation had no way to state that. This issue closes
that gap: all three standing accounts now accept an authored starting balance.

Goal fund accounts are unaffected by design — they accumulate toward a target from
$0, which is a different concept from "money already there."

## RGR Verification Details

Two vertical slices, each red → green:

1. **Engine** (`packages/engine/src/compile/projectionBase.test.ts`): added a test
   asserting `buildPlanAccounts` opens retirement/brokerage at the plan's authored
   `retirementOpeningBalanceCents`/`brokerageOpeningBalanceCents`. Confirmed it failed
   (`expected +0 to be 5000000`) against the hardcoded `balanceCents: 0`, then made it
   pass by reading the new optional `Plan` fields with a `?? 0` fallback.
2. **App** (`packages/app/src/components/budgetEditor/budgetEditor.test.tsx`): added
   assertions for two new labeled inputs and a test that each fires the matching
   `updatePlan` patch independently. Confirmed both failed (`getByLabelText` found no
   match), then added the two `NumInput` controls to `BudgetEditor` to make them pass.

Full targeted suites (`projectionBase.test.ts`, `budgetEditor.test.tsx`, `debugPanel`)
green throughout; `npm run typecheck` clean; full `packages/engine` + `packages/app`
vitest run and `npm run check` show only two pre-existing failures in
`comments.guard.test.ts`, confirmed via `git stash` to fail identically on the branch
baseline before this change (a stale guard referencing
`.sandcastle/new_flow/implement-prompt.md` phrasing removed by an earlier,
unrelated commit) — not introduced by this work.

## Key Decisions & Why

- **New fields are optional, defaulting to 0** (`Plan.retirementOpeningBalanceCents?`,
  `Plan.brokerageOpeningBalanceCents?`), unlike the required `openingBalanceCents`.
  This preserves the prior behavior for every existing fixture, preset, and plan
  without a value (0 was always the only possible value before), and needed no changes
  to `PlanPatch`/`withPlanPatch`/`ScenarioInput`: both are generic over `Plan`'s
  scalars (`Omit<Plan, "goals" | "budgetLines" | "primary">`), so the new fields flow
  through `updatePlan` and `Projection.fromInput` for free.
- **Renamed the existing "Opening balance" control to "Cash opening balance"** in both
  `BudgetEditor` and the debug panel, since "Opening balance" is now ambiguous across
  three accounts. Added "Retirement opening balance" / "Brokerage opening balance" as
  plain (non-Advanced) `NumInput` fields beside it — a starting balance is a fact about
  the household, not a tunable assumption like the return-rate fields already
  disclosed under "Advanced".
- **No changes to goal fund accounts.** They are always minted at `balanceCents: 0`
  by design (a goal accumulates toward a target); that is a different concept from an
  account someone already funded before month 0, and out of scope for this issue.

## Changes Made

- `packages/engine/src/plan/plan.ts` — added optional `retirementOpeningBalanceCents`
  and `brokerageOpeningBalanceCents` to `Plan`.
- `packages/engine/src/compile/projectionBase.ts` — `buildPlanAccounts` reads the new
  fields (`?? 0`) instead of hardcoding `balanceCents: 0` for the retirement and
  brokerage standing accounts.
- `packages/engine/src/compile/projectionBase.test.ts` — new `describe` block covering
  the zero-default and authored-balance cases.
- `packages/app/src/components/budgetEditor/budgetEditor.tsx` — renamed "Opening
  balance" to "Cash opening balance"; added "Retirement opening balance" and
  "Brokerage opening balance" `NumInput` controls, each routing through `updatePlan`.
- `packages/app/src/components/budgetEditor/budgetEditor.test.tsx` — updated the
  ambiguous label assertion, added coverage for the two new controls and their
  independent `updatePlan` patches.
- `packages/app/src/components/debugPanel/debugPanel.tsx` — renamed "Opening balance"
  to "Cash opening balance"; added "Retirement opening balance" / "Brokerage opening
  balance" rows to the "Accounts & returns" group for parity.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check` (purity + typecheck + full vitest run) — 1846 tests green, 45 todo,
  2 pre-existing unrelated failures (confirmed present on the branch baseline via
  `git stash`, in `comments.guard.test.ts`, unrelated to this issue).
- Targeted suites (`projectionBase.test.ts`, `budgetEditor.test.tsx`, `debugPanel/*`)
  all green.
