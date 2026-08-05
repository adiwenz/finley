# Issue 267 — A partner now has a life expectancy, and the horizon says whose it is

## Overview

The projection ran to the **primary's** life expectancy, whoever else was in the household. A
younger partner's last years were unmodelled and unflagged: `authoredPlanSurvives` and the solved
retirement age both came back clean on a plan that leaves the survivor broke, and the retirement
panel said "age 90" with no possessive — reading as a household guarantee when it meant one
person's own horizon.

This branch closes that in the two separable fixes the issue names, plus the panel copy that ties
them together, following the design decision recorded in the issue's comments (horizon = max across
members; a member's expectancy bounds only their own income/benefit; household spending never steps
down — the survivor is funded at full cost, conservative not dangerous).

Delivered as three commits:

1. **Disclose the horizon (panel copy).** The retirement panel's life-expectancy mentions gained a
   possessive.
2. **Give `Person` a life expectancy (engine).** The horizon becomes the longest-lived member's;
   each member's government benefit stops at their own expectancy.
3. **Name whose expectancy the horizon rests on (this commit).** The panel names the longest-lived
   member — the partner when they outlive the primary — instead of always the primary.

## Key decisions & why

- **`Person.lifeExpectancy` is OPTIONAL, inherit-on-read.** `undefined` means "use the household's"
  (`Plan.lifeExpectancy`), resolved at the sim boundary — the same shape `continuationJobId` uses.
  This kept the change off ~35 existing `Person` fixtures. The primary always carries a concrete
  value (built from the plan); a partner stores one only when `marry({ lifeExpectancy })` states it,
  else inherits the household's live value rather than freezing it at marriage.

- **A member's expectancy bounds ONLY the government benefit, never a wage.** The decision keeps
  "jobs end at their stated age regardless". A first attempt folded death into the shared
  `HouseholdMembership.endMonth`, which also clipped a partner's jobs (breaking the
  `plannedWorkStopAge` solver tests that pin authored job ends). The bound instead lives on
  `SimPerson.lifeEndMonthExclusive`, read only at the benefit gate. Household spending is not gated
  by membership, so it runs on to the extended horizon and funds the survivor at full cost.

- **Horizon = max member reach = `max(primary, per-member min(separation, death))`.** A staying
  younger partner extends the run to their tail; a partner who separates before their own expectancy
  never does (#266's window still governs them). Computed once in `buildHouseholdInput`.

- **The solved age and `plannedWorkStopAge` stay in the PRIMARY's years** (unchanged): they are
  facts about the household reaching one calendar boundary. Only the *horizon* the portfolio must
  last to is re-anchored, and the panel names whose it is via a new `RetirementSolution.horizonAnchor`
  (longest-lived member's name + age), so the copy and the solved age keep their separate clocks.

- **A tie falls to the primary**, so an ordinary same-age household still reads "your life
  expectancy" and only a genuinely longer-lived partner is named.

## RGR verification details

- **Horizon (RED→GREEN):** `projectionFacade.run.test.ts` — a younger partner's run went from **540**
  months (the primary's expectancy, the bug) to **660** (the partner's); an explicit
  `lifeExpectancy: 95` reaches **780**; an older partner does not shrink it.
- **Benefit window (RED→GREEN):** `governmentBenefit.test.ts` — a member's benefit stops at
  `lifeEndMonthExclusive` even while still a member, and the min of separation and expectancy governs
  when both apply.
- **Anchor (RED→GREEN):** `retirementSolver.test.ts` — `horizonAnchor` names the primary (null) when
  nobody outlives them, a younger partner (at their inherited or own expectancy) when they do, and
  ignores a separated partner.
- **End-to-end:** `scenarios.test.tsx` renders the real panel — a younger partner makes the survival
  sentence read "Sam's life expectancy (age 85)", a same-age partner keeps "your life expectancy".
- All values were observed in the REPL (`npm run repl`) before being pinned, per `AGENTS.md`.

## Changes made

Engine:
- `plan/person.ts` — optional `lifeExpectancy`.
- `job/householdJob.ts` — `lifeExpectancyEndMonthExclusive(person, nowYear, fallbackAge?)`.
- `projection/simulate.types.ts`, `compile/compilePerson.ts` — `SimPerson.lifeEndMonthExclusive`.
- `projection/governmentBenefit.ts` — benefit stops at the member's expectancy.
- `projection/buildHouseholdInput.ts` — horizon = max member reach; thread each member's life-end.
- `ledger/ledgerBase.ts`, `compile/projectionBase.ts` — `householdLifeExpectancyAge`; primary's
  expectancy on the standing Person.
- `authoring/relationships.ts` — `marry`/`startPartnered` accept and validate `lifeExpectancy`.
- `retirement/retirementTypes.ts`, `retirement/retirementSolver.ts` — `HorizonAnchor` +
  `horizonAnchorOf`, added to `RetirementSolution`.

App:
- `components/retirementPanel/retirementPanel.tsx` — `LifeExpectancy` helper names the anchor member
  at the five life-expectancy sites.
- `retirementView.ts` — exposes `horizonAge` / `horizonMemberName` from the solution.

## Verification & testing

`npm run typecheck` clean, engine purity clean, **engine 1045 passed / 45 todo**, **app 675 passed**.
