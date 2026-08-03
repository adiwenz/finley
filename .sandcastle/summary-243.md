# Issue #243 — Derive the stop-working boundary instead of rewriting job ends

## Overview

The retirement solver used to answer "when could this household stop working?" by rewriting
every job's end date on a copy of the plan (`ceaseAllJobsAtAge`) for a full stop, and by
re-pinning `Plan.retirementAge` for a partial one. Both mutated the plan's own job list — and
because a partner's jobs are stored on the `RelationshipEvent` that brought them into the
household rather than on the plan, the full-stop transformation never reached them. The
retirement answer was wrong for every two-earner household: one earner kept working past the
stop-working age.

This change turns the retirement target into a **stop-working boundary**: a compile-time
simulation cap on jobs, varied by the solver as a single scalar and applied to every earner. No
job is ever rewritten, so a solve is provably non-destructive, and the boundary reaches the
primary and any partner through the one compilation path they share.

## Key Decisions & Why

- **A calendar-year boundary, not a per-person age.** `StopWorkingBoundary` carries an exclusive
  calendar year (`boundaryYearExclusive`), derived once from the primary's candidate age. A
  calendar year makes the whole household stop at the same point in time regardless of each
  earner's birthday, and — since the candidate age is never below the current age — the boundary
  is never before "now", so it can only shorten a job, never resurrect a wage in a partner's
  past. For the primary earner this is byte-identical to the old `capYear = birthYear + age`, so
  single-earner behaviour is unchanged.

- **The boundary lives in compilation, resolved by `jobEndYearExclusive`.** That function already
  derived an open-ended job's end from the owner's `retirementTargetAge`; it now also takes an
  optional boundary. A **full** stop caps every job (`Math.min(endYear, boundary)`), a **partial**
  stop resolves only the open-ended jobs to the boundary and leaves each fixed-term job its
  authored end. Absent a boundary (an ordinary projection), each person's own
  `retirementTargetAge` still ends their open-ended jobs — no behaviour change off the solve path.

- **The boundary rides on `LedgerBaseConfig` so it reaches both compilation paths.**
  `createProjectionBase` applies it to the primary's jobs and stores it on the base;
  `interpret`'s `partnerJobSeries` reads it back and applies it to a partner's jobs. One value,
  both earners.

- **The solver varies the scalar, never a job.** `evaluateAtAge` (partial) and
  `projectFullRetirement` (full) now pass a `StopWorkingBoundary` to `projectScenario` instead of
  building a mutated plan. `ceaseAllJobsAtAge` and the `withPlan` re-pins are gone. The public
  solver API (`solveRetirement`, `evaluateFullRetirementAtAge`, the two `earliest*` searches) is
  unchanged, so `retirementOutlook.ts` and the app need no edits.

## RGR Verification Details

- **RED:** A new two-earner scenario (primary plus a partner on a `RelationshipEvent`, the partner
  authored to work to age 80) solved for a full stop at 50. Asserting the household draws no
  earned income ten years past the boundary failed on the old code — the partner still earned
  ~$3,612/mo, exactly the unstopped-partner bug.
- **GREEN:** Threading the boundary through compilation ceased the partner's jobs at the same
  calendar year as the primary's; income at month 240 became 0.
- A second guard test snapshots the scenario (`JSON.stringify`), runs all five solver entry points
  over it, and asserts the serialization round-trips unchanged — the non-destructiveness AC.

## Changes Made

- `packages/engine/src/compilePerson.ts` — new exported `StopWorkingBoundary` type;
  `jobEndYearExclusive` takes an optional boundary and applies full/partial capping;
  `compileJobIncome` and `compilePersonIncomeSeries` thread it through.
- `packages/engine/src/ledger/ledgerBase.ts` — `LedgerBaseConfig.stopWorking` carries the boundary
  to interpretation.
- `packages/engine/src/projectionBase.ts` — `createProjectionBase` takes an optional boundary,
  applies it to the primary's income series, and stores it on the base.
- `packages/engine/src/ledger/interpret.ts` — `partnerJobSeries` applies `base.stopWorking` to a
  partner's jobs.
- `packages/engine/src/retirementSolver.ts` — `projectScenario`/`projectScenarioParts` take an
  optional boundary; `evaluateAtAge` and `projectFullRetirement` pass a partial/full boundary
  instead of a rewritten plan; `stopWorkingBoundaryAt` builds it; `ceaseAllJobsAtAge` removed.
- `packages/engine/src/retirementSolver.test.ts` — two-earner full-stop regression and the
  non-destructiveness guard.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity intact.
- Full suite: **1577 tests green** (925 in `packages/engine`), 45 todo. Existing single-earner
  solver behaviour (survival monotonicity, threshold ages, partial < full on the barista plan,
  latest-authored-work-stop age) is unchanged.
