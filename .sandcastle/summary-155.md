# Issue #155 — Goal-completion derivation: latched In-Progress → Funded from the projection series (#129 slice)

## Overview

Goal completion is now **derived from the projection series**, never stored. Each
goal is binary — **In Progress → Funded** — where *Funded* means the goal's fund
balance reached its target at some month **on or before** the target date. The state
**latches**: because it is decided by the *earliest* reaching month, a later timeline
event draining the account can never move a Funded goal back to In Progress. There is
zero cross-reference between events and goals (no stored status, no `satisfiesGoalIds`).
"Behind pace" reuses the existing `onTrackFraction` — no new engine state — and the
Goals panel renders both the In-Progress/Funded badge and the behind-pace flag.

## RGR Verification Details

Three Red-Green cycles, one per seam:

1. **Engine — `computeGoalProgress` derivation** (`packages/engine/src/goal.test.ts`)
   - **RED:** New tests asserted `progress.completion` for four cases (latched-through-drain,
     never-reached, reached-only-after-date, `asap`). All failed — `completion` was `undefined`.
   - **GREEN:** Added a `GoalCompletion` union and a scan over months `0..targetMonth` that
     latches `"funded"` on the first month whose fund balance ≥ target. Tests pass.
   - Built an independent source of truth (`seriesFromFundBalances`) so the latch case is
     pinned by a hand-authored balance curve (rises to target at month 10, drained to 0 at
     month 20, target date 24) — not by the simulator's own draw-down semantics.

2. **App view — `goalRows`** (`packages/app/src/goalsView.test.ts`)
   - **RED:** Tests asserted `rows[0].completion` and `rows[0].behindPace`; failed (fields absent).
   - **GREEN:** `GoalRow` gained `completion` (passed through from the engine) and `behindPace`
     (`inProgress && onTrackFraction < 1`). Tests pass.

3. **App component — `GoalsPanel`** (`packages/app/src/components/goalsPanel/goalsPanel.test.tsx`)
   - **RED:** Tests asserted the rendered HTML contains "Funded" / "In progress" + "Behind pace"; failed.
   - **GREEN:** Added a status badge (`Funded` vs `In progress · Behind pace`) to the goal head. Tests pass.

## Key Decisions & Why

- **Scan, don't store.** Completion is computed each render from the projection series, exactly
  as `onTrackFraction` already is. Nothing persists it, so it can never disagree with the curve.
- **Latch = break on first reach, scan only up to the target month.** Iterating `0..targetMonth`
  and breaking on the first `balance ≥ target` captures "reached on/before the date **and** latches"
  in one loop: a drain that happens after the reach is either past the target month (never scanned)
  or after the break (never seen). No separate "was it ever funded" bookkeeping is needed.
- **`asap` goals** measure at the horizon end (`targetMonth = lastMonth`), matching how
  `onTrackFraction` already treats them — Funded if the balance ever reaches target across the horizon.
- **Zero-target goals** are trivially Funded (`0 ≥ 0` at month 0), consistent with their
  `onTrackFraction` of 1.
- **`behindPace` lives in the view, not the engine.** The issue says behind-pace *reuses*
  `onTrackFraction` with "no separate state", so it is derived in `goalRows` rather than added to
  `GoalProgress`. A Funded goal is never behind pace (the `completion` check short-circuits).

## Changes Made

- **`packages/engine/src/goal.ts`**
  - New exported `GoalCompletion = "inProgress" | "funded"` type with doc comment on the latch semantics.
  - `GoalProgress` gains a `completion: GoalCompletion` field.
  - `computeGoalProgress` scans months `0..targetMonth` and latches `"funded"` on first reach.
- **`packages/engine/src/goal.test.ts`** — `seriesFromFundBalances` / `fundGoal` helpers and a new
  "completion (In Progress → Funded, latched)" describe block (latch-through-drain, never-reached,
  reached-after-date, `asap`).
- **`packages/app/src/goalsView.ts`** — `GoalRow` gains `completion` and `behindPace`; `goalRows` populates them.
- **`packages/app/src/goalsView.test.ts`** — new describe block covering Funded and In-Progress/behind-pace rows.
- **`packages/app/src/components/goalsPanel/goalsPanel.tsx`** — status badge in the goal head.
- **`packages/app/src/components/goalsPanel/goalsPanel.test.tsx`** — render tests for the Funded and
  In-progress/Behind-pace badges.
- **`packages/app/src/assets/styles/globals.css`** — `.goal-status` / `-funded` / `-in-progress` badge styling.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity guard passes (no I/O, no app/rules imports).
- `npm run test` — **910 passed | 45 todo (955)** across 77 files, all green.

## Notes for the next iteration

- The badge is deliberately minimal (a pill in the goal head). Any richer completion timeline
  (e.g. "funded in month N") is out of scope for this binary slice.
- Independent of #151 and the Home Purchase / One-Time Spend slices; blocked-by #150 (disposition
  purge) is already merged on this branch's base.
