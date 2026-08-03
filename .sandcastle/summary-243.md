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

## Correctness follow-up (post-review)

Two correctness issues surfaced in review of the above, plus a naming cleanup:

### 1. The boundary could extend a job past its own natural end

`jobEndYearExclusive` (compilePerson.ts) now always derives a job's natural end first —
`job.endYear ?? owner.birthYear + owner.retirementTargetAge` — and only ever narrows it with
`Math.min(natural, boundary)`, in both `"full"` and `"partial"` mode. Previously an open-ended
job resolved straight to `stopWorking.boundaryYearExclusive`, which could EXTEND a partner past
their own authored `retirementTargetAge` (or an owner's explicit `endYear`) whenever the
boundary — derived from the primary's candidate age — fell later than that owner's own natural
stop. Fixed jobs already correctly resisted extension (via a prior `Math.min` in full mode, and
by being left untouched in partial mode); only open-ended jobs needed the fix.

**Partial-mode semantics, stated precisely:** a partial stop moves an open-ended job's end to
`min(its own natural end, the boundary)` — i.e. it can shorten an open-ended job toward the
boundary, but never past its own authored natural end, and it never touches an explicit
`endYear` in either direction. Full mode applies the same `min` to every job, including
fixed-term ones (already the existing, correct behavior there).

This meant the primary's own open-ended job needed a matching change so the solver can still
search candidate ages *past* the authored `retirementAge` (the entire point of
`earliestFullRetirementAge`/`earliestPartialRetirementAge`): `createProjectionBase`
(projectionBase.ts) now resolves the compiled `standingPerson.retirementTargetAge` from the
boundary itself when a solve is under way (`boundaryYearExclusive − birthYear`), rather than
leaving it pinned at `budget.retirementAge`. This keeps the natural-end cap in
`jobEndYearExclusive` fully owner-agnostic (no primary-special-casing there) while making the
primary's own candidate age — not a partner's — the one thing the cap can never fall behind.
A partner's `retirementTargetAge`, authored on their `RelationshipEvent`, is never touched this
way, so it acts as a real ceiling on their job precisely as the fix intends.

Regression tests (`retirementSolver.test.ts`): an older partner whose own natural retirement
predates the primary's candidate boundary (full and partial mode), a fixed-term partner job with
an explicit end before the boundary, and confirmation the boundary still shortens a partner
authored to work later than the candidate — including that no wage or payroll tax posts past
the natural end.

### 2. `latestAuthoredWorkStopAge` → `plannedWorkStopAge`, and made household-wide

Renamed throughout (no more "latest" in names/comments — the concept is "the household's planned
work stop," not a max-of-a-collection detail) and split into two pieces:

- `plannedWorkStopYear` (internal): the household-wide `max` calendar year, over EVERY job
  anywhere in the household (primary's plan jobs and every partner's, via
  `Household.memberships` — the same roster `interpretLedger` builds and `partnerJobSeries`
  already draws its persons from, so this can never disagree with what the projection rosters).
- `plannedWorkStopAge` (public, on `RetirementSolution`): the year converted to an age through
  the PRIMARY's birth year — never a partner's own age, even when the partner's job is the one
  that sets the household-wide max.

Previously this only looked at `scenario.plan.jobs`, so a partner's job (which lives on their
`RelationshipEvent`, not the plan) was invisible to it entirely — the same class of bug #243
fixed for the boundary itself.

Regression tests cover: a partner job outliving every primary job, a partner with a different
birth year (converted through the primary's, not their own), an open-ended vs. explicitly-ended
partner job, a separated (inactive) partner's job still counting (per `Household.memberships`'
own existing roster rule — nothing new invented), and multiple relationship events.

Full suite: 1587 tests green (up from 1577), typecheck and purity clean.

## One membership-aware household job (follow-up refactor)

`{ job, owner }` lost the household membership, which is a real cap on when a person's wages
belong to the projected household — so the two places that needed it (`compilePerson` and the
`plannedWorkStopAge` read) had to reassemble it separately, and only one of them did.

New `householdJob.ts` holds the single derived concept:

- `HouseholdJobContext` — `{ job, owner, membership }`, built only via `personJobContexts()` /
  `householdJobContexts(memberships)` so `owner` and `membership.person` cannot come apart.
- `ResolvedHouseholdJob` — a context with every cap intersected: `endYearExclusive` (the
  employment's end, capped by any candidate boundary), `employmentStartMonth` (the salary-growth
  anchor), `paidStartMonth` / `paidEndMonthExclusive` (the household participation window), and
  `paysHousehold`.
- `resolveHouseholdJobs()` — the one function that does the intersecting.

Four caps, one direction. An authored `endYear`, an owner's `retirementTargetAge`, a household
membership, and a solver's candidate `StopWorkingBoundary` are all ceilings; resolution takes the
tightest and none of them can extend past another. `StopWorkingBoundary` moved here too, since
it is now one cap among four rather than a compilation detail.

Everything wage-derived now reads that one window. `compilePersonIncomeSeries(person, ...,
membership?, stopWorking?)` became `compileHouseholdJobSeries(resolvedJobs, ...)` — it no longer
computes a span at all, so employment income, payroll tax, 401(k) deferral and employer match
(all downstream of the compiled series) inherit the resolved window by construction rather than
by four callers agreeing. `createProjectionBase` passes the primary's own always-open membership
(`startMonth: -Infinity`, `endMonth: null`) instead of `undefined`, which removes the last
primary-only branch from job compilation.

Authored vs. derived stays split: `Job` grows no "effective end". The intersection exists only as
a `ResolvedHouseholdJob`, rebuilt each pass, which is what keeps a solver candidate from touching
the scenario.

**One behaviour change.** `plannedWorkStopAge` now reports the household's final WAGE rather than
the final job owned by anyone who ever belonged to the household: a separated partner's job stops
counting at the separation, not at the retirement target they will reach outside this household.
That is what the projection was already paying, so the read and the graph now agree.

Tests: an active partner paying through their whole window (wage and deferral), a separated
partner whose wage, deferral and employer match all stop at the separation, a candidate boundary
shortening a membership-clipped job without ever outliving the separation, and the
`plannedWorkStopAge` reads for both an active and a separated partner.
