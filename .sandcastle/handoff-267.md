# Handoff — issue 267

Whole-issue mode (issue declares no tasks). Split into three parts; each lands green.

**My breakdown:**

- **Part 1 — Disclose the horizon (retirement panel copy). DONE.** See first commit. `LifeExpectancy`
  helper renders "your life expectancy (age 90)" at the panel's five life-expectancy sites.
- **Part 2 (engine) — `Person.lifeExpectancy` + horizon = max across members + benefit window. DONE
  (this commit).** See below.
- **Part 3 — Panel copy names WHICH member's expectancy drives the horizon. REMAINING.** The last
  piece; see "Remaining" below.

## Live constraints (Part 2 engine, as built)

- **`Person.lifeExpectancy?` is OPTIONAL** (`packages/engine/src/plan/person.ts`). `undefined` =
  inherit the household's (`Plan.lifeExpectancy`), resolved on read — the same shape
  `continuationJobId` uses. This kept the change off ~35 test fixtures. The primary Person always
  carries a concrete value (`createProjectionBase` sets it = `budget.lifeExpectancy`); a partner
  stores one only when `marry({..., lifeExpectancy})` states it, else inherits live.
- **The fallback age rides on the base.** `LedgerBaseConfig.householdLifeExpectancyAge` (=
  `budget.lifeExpectancy`) is set by `createProjectionBase` and is the fallback every read uses.
- **`lifeExpectancyEndMonthExclusive(person, nowYear, fallbackAge?)`** in
  `packages/engine/src/job/householdJob.ts` is THE one statement of a member's death month. Returns
  `Infinity` when neither the member nor the household names an expectancy (legacy unbounded).
- **Death bounds ONLY the government benefit and the horizon — never a wage.** This is deliberate
  and the design decision demands it ("jobs end at their stated age regardless"). Two solver tests
  (`retirementSolver.test.ts`, `plannedWorkStopAge is household-wide`) pin that a partner job
  authored PAST their expectancy still reports its authored end. My first attempt folded death into
  the shared `HouseholdMembership.endMonth`, which clipped those jobs and broke them — reverted.
  The bound now lives on `SimPerson.lifeEndMonthExclusive` (`simulate.types.ts`), set by
  `compilePerson`, and is read ONLY at `governmentBenefit.ts` (the gate right after the membership
  check). Do NOT move it back onto the membership window.
- **Horizon** is computed in `buildHouseholdInput.ts` = `max(base.horizonMonths, per-member
  min(separation, death))`. `base.horizonMonths` stays the primary's floor.
- **Purity trap:** never name a variable/property `window` in engine src — the purity guard reads
  it as the browser global (see `simulate.types.ts` note). Cost me 3 false violations.

## Dead ends

- Folding the death month into `HouseholdMembership.endMonth` at `interpret` — clean and unified,
  but it clips a partner's JOBS at death (via the shared `membershipWindow`), which the decision
  forbids. Use the separate `SimPerson.lifeEndMonthExclusive` benefit gate instead.

## Remaining — Part 3 (panel copy)

- The panel's `LifeExpectancy` helper (`packages/app/src/components/retirementPanel/retirementPanel.tsx`)
  still says "your life expectancy (age {budget.lifeExpectancy})" — the PRIMARY's. Now that the
  horizon can be a partner's (a younger partner extends it), the copy should name whichever member's
  expectancy the portfolio must actually last to. The panel today receives only `view` + `budget`
  and has no member roster / horizon-driver. Thread the horizon-driving member (name + age) through
  `RetirementView` (`packages/app/src/retirementView.ts`) from the run, and have the copy name them
  when it is not the primary. Keep the solved headline age in the PRIMARY's years (unchanged).
- Then write `.sandcastle/summary-267.md` and DELETE this handoff in the finishing commit.

## Deferred (out of scope by the issue's design decision)

- Per-member budget attribution / spending step-down at a member's death — household spending runs
  unchanged to the horizon, funding the survivor at full cost (conservative). A follow-up.
- `membersAt`/snapshot roster still lists a member after their expectancy (it reads
  `HouseholdMembership.endMonth`, which can't carry death without clipping jobs — see Dead ends).
  Benefit and horizon are correct; only the display roster overstates presence in survivor years.
