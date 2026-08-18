# Issue #305 — Stop funding goals after their end date

## Overview

Dated goals (a `SimGoal`/`GoalPlan` with a concrete `targetDate`, as opposed to `"asap"`) kept
receiving contributions in `runWaterfall` even after their target month had passed and the
target was not yet reached. The sinking-fund pace calculator (`requiredContributionCents`)
treats any `monthsRemaining <= 1` as "due in full now," which is correct for the goal's final
active month but was also firing — incorrectly — for every month afterward, so an expired,
underfunded goal kept soaking up the entire remaining gap indefinitely instead of stopping.

## RGR Verification Details

- **RED:** Added a test in `packages/engine/src/projection/waterfall.test.ts` — a $12,000 goal
  due at month 12, $6,000 saved, evaluated at `nowMonth: 13` — asserting the goal receives no
  further deposit and the freed cash flows to the surplus destination instead. Ran it against
  the pre-fix code and confirmed it failed with the goal still absorbing the surplus
  (`expected 300000 to be undefined`).
- **GREEN:** Added a one-line guard in `fundGoalsAndContributions`'s Pass 1 loop
  (`packages/engine/src/projection/waterfall.ts`): `if (nowMonth > goal.targetDate) continue;`,
  placed alongside the existing `goal.targetDate === "asap"` skip. Re-ran the new test — green
  — then the full `waterfall.test.ts` file (55/55) and the full repo suite.
- **REFACTOR:** No structural changes needed; the fix is a single conditional colocated with
  the existing dated-goal skip, consistent with the file's existing style and the RMD
  `isPersonActiveAt` precedent (issue #266) for "does this window still cover `month`?" gates.

## Key Decisions & Why

- **Fix point:** the gate lives in `waterfall.ts`'s per-goal loop, not inside
  `requiredContributionCents`. That function's docstring states its two early returns are
  "limits of the annuity formula, not special-cased guesses" — an expiration check is a
  window/eligibility concern, not pace math, so it belongs at the call site. This mirrors an
  existing precedent in the same codebase: `budgetLine.ts`'s `goalPaced` amount source already
  guards `monthsLeft <= 0` at its own call site before invoking the same pace function, rather
  than inside it.
- **Boundary semantics:** `targetDate` is the month the goal is "wanted by," so the deadline
  month itself must still fund normally (any gap is due in full that month — existing
  behavior, unchanged), and the funding window closes starting the *following* month. Hence
  `nowMonth > goal.targetDate`, not `>=`.
- **No change to already-accumulated money:** `fundGoalsAndContributions` only ever adds
  deposits; it has no withdrawal path. Skipping the loop iteration for an expired goal means it
  simply never appears in `accountDepositsCents` — the caller's account balance is left exactly
  as provided, satisfying "do not change or remove money already accumulated."
- **Surplus routing is automatic:** because the expired goal's contribution is skipped
  entirely (not zeroed after being counted), it never touches `sharedPoolRemaining` or
  `personalRemaining`, so `goalDepositsTotal` reflects only real deposits and the existing
  surplus-conservation math (`totalDiscretionary - goalDepositsTotal`) naturally releases the
  freed cash to other goals, then to the surplus destination — no new logic was needed for
  criteria 2 and 3.
- **Fully-funded-goal behavior (criterion 2) was already correct** via `fundGoalUpTo`'s
  `need <= 0` short-circuit; a regression test was added to pin it, but no code change was
  required there.
- **Scope:** `budgetLine.ts`'s separate `goalPaced` amount source (a different authoring
  concept, standing budget-line pacing) already zeroes out past its own deadline and was left
  untouched — out of scope for this issue, which concerns the `SimGoal` funding waterfall.

## Changes Made

- `packages/engine/src/projection/waterfall.ts` — `fundGoalsAndContributions`: added
  `if (nowMonth > goal.targetDate) continue;` in the dated-goal (Pass 1) loop, so a goal whose
  funding window has closed is skipped before any pace is computed or funded.
- `packages/engine/src/projection/waterfall.test.ts` — five new regression tests under
  `runWaterfall — goals (steps 4–5, fund-to-pace)`:
  1. A goal that expires short of its target stops receiving contributions after its end
     month, and the freed cash reaches the surplus/idle destination.
  2. A fully funded goal receives no additional contributions (pre-existing behavior, now
     pinned).
  3. With two goals, expiring one lets the other keep pacing normally and still routes the
     rest to surplus.
  4. Money accumulated in the goal's account while active is left untouched once expired (no
     deposit or withdrawal is recorded against it).
  5. Boundary: the goal funds normally in its final active month, then receives exactly $0
     starting the following month.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — clean.
- `packages/engine/src/projection/waterfall.test.ts` — 55/55 passing (50 pre-existing + 5 new).
- Full repo suite (`npm run test`) — 146 test files, 2032 tests passing, 45 todo (pre-existing,
  unrelated).
