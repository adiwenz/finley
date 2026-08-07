# Issue 267 — A partner now has a life expectancy, and the horizon says whose it is

## Overview

The projection ran to the **primary's** life expectancy, whoever else was in the household. A
younger partner's last years were unmodelled and unflagged: `authoredPlanSurvives` and the solved
retirement age both came back clean on a plan that leaves the survivor broke, and the retirement
panel said "age 90" with no possessive — reading as a household guarantee when it meant one
person's own horizon.

This branch closes that in the two separable fixes the issue names, plus the panel copy that ties
them together, following the design decision recorded in the issue's comments (horizon = max across
members; a member's expectancy bounds only their own income and benefit; household spending never
steps down — the survivor is funded at full cost, conservative not dangerous).

Delivered as three commits:

1. **Disclose the horizon (panel copy).** The retirement panel's life-expectancy mentions gained a
   possessive.
2. **Give `Person` a life expectancy (engine).** The horizon becomes the longest-lived member's;
   each member's government benefit stops at their own expectancy.
3. **Name whose expectancy the horizon rests on (this commit).** The panel names the longest-lived
   member — the partner when they outlive the primary — instead of always the primary.

## Key decisions & why

- **`Person.lifeExpectancy` is REQUIRED — every person carries their own, and NOTHING defaults it.**
  It began as optional ("inherit the household's", resolved at the sim boundary), which kept the
  change off ~35 `Person` fixtures but cost more than it saved: the type could not say what the
  projection ran to, every read site needed the fallback threaded to it, five read sites had
  invented DIFFERENT answers for an absent one (a horizon of 0 months against a slider reading 120),
  and a plan whose primary also stated none projected nothing.

  A partner does not fall back to the primary's either: `marry`/`startPartnered` require one. How
  long a person lives is a fact about them, not about whoever they married, and a partner ten years
  younger silently handed age 90 would extend the horizon by a decade nobody chose. Both partner
  forms therefore ask for it, opening on a visible, editable default rather than an inferred one.

  Refused rather than defaulted at every door: `Projection.init` and `marry` throw, `fromInput`
  answers `{ ok: false }`, and `restoreState` checks every person on the way in. The format version
  is NOT bumped — nothing has ever been persisted, so there is no older shape for a version to
  distinguish, and a bump would describe a migration that never happened.

- **A member's expectancy closes ONE window, and everything person-scoped is clipped by it.**
  `personActiveWindow` (`job/personActiveWindow.ts`) is membership ∩ life: from the month they
  joined to the earlier of separating and dying. A job's employment ends at `min(authored end,
  death)`; a raise, a bonus or a missed paycheck dated outside it is not applied; a government
  benefit is not paid outside it; and the simulator gates every income series by its owner's
  window, which catches the event-authored streams (alimony) and anything added beside them
  without each having to remember death for itself.

  It began as two bounds with separate reach — membership clipped wages and the benefit, the
  expectancy clipped only the benefit, by a second check written beside the first — so a wage went
  on being paid to a household years after the earner had died, while that same person's Social
  Security had already stopped. The two are intersected once now, so the projection, the chart's
  job bar (`resolveJobPayDisplay`) and the household's resolved span (`resolvedJobPaySpan`) cannot
  answer with three different end dates. `SimPerson.membership` + `lifeEndMonthExclusive` collapsed
  into the single `SimPerson.activeWindow`, and `isHouseholdMemberAt` became `isPersonActiveAt`.

  **Household spending is deliberately not in the window.** It runs unchanged to the horizon,
  funding the survivor at full cost — conservative rather than dangerous, and the reason this is a
  *person* window and not a household one.

  Authoring keeps a matching asymmetry. A job whose START is past its owner's death is REFUSED
  (`assertPersonEventsStillReachable`): nothing survives interpreting it. A job that merely
  outlasts its owner is accepted and clamped at run time — it is worked until they die — because
  refusing it would make "I'll work as long as I can" an unwritable plan. The Jobs card discloses
  the difference rather than hiding it: "age 25–95 · ends at 80 (life expectancy)", so the
  authored ages stay editable and the chart beneath them is not left contradicting the line above.

- **A life expectancy must be PAST the age the person already is** (`invalidAge`, formerly
  `ageAboveMaximum`). One at or below it says they are already dead: their window closes at month
  0, so no job of theirs pays a month, no benefit is ever claimed, and a single-member plan
  projects nothing. Well-defined and useless — and reachable by dragging a slider, not only by a
  typo. Refused at every authoring door the ceiling is already checked at (`init`, `updatePlan`,
  `marry`/`startPartnered`, `fromInput`) and, like every other one of these rules, NOT on restore.
  The Budget editor's age fields now chain with a one-year gap instead of meeting, so the form
  cannot clamp to a value the next write rejects.

- **Horizon = max member reach, and a separation only counts while BOTH are alive.** A staying
  younger partner extends the run to their tail. A partner who separates does not — but only if the
  separation lands strictly before `min(their death, the primary's)`. You cannot leave a household
  you have died out of, or leave a partner who has already died, so a separation at or after that
  boundary is not an event in either life and the partner is covered to their own death like anyone
  else. (Primary dies 2070, partner dies 2080, separation booked 2085 → the run reaches 2080.)
  #266's window still governs their income and benefit either way.

  The rule is ONE function, `memberHorizonReach` in `job/personActiveWindow.ts`, called by both
  `buildHouseholdInput` (the simulated horizon) and `horizonAnchorOf` (the age the panel prints), so
  the graph and the sentence describing it cannot diverge. They used to hold separate copies, and
  both copies had the same bug: any separation, at any date, cancelled the partner's tail.

- **An impossible date is REFUSED at authoring, in both directions.** `marry` and `separate` throw
  for a month at or after `min(the primary's death, the partner's)` — the same boundary — because
  each is a thing a couple does. Refused before the first mint, so nothing is issued and abandoned;
  `fromInput` turns it into `{ ok: false }`, and the app's `useProjection` already renders a thrown
  write as a conflict, so each reason is written to survive the `Projection: cannot X —` prefix
  being stripped.

  The other direction is an EDIT that strands something legal when written, and it is not about
  separations: `assertPersonEventsStillReachable` (`authoring/reachability.ts`) revalidates every
  PERSON-SCOPED thing against the state an edit would produce. Which things those are is read off
  the ownership each already carries — the couple events (`RelationshipEvent`, `SeparationEvent`)
  take the primary plus whoever they name, the owned events (`LoanEvent`, `HomePurchaseEvent`) take
  their `ownerId`, and a job takes its owner. A `ChildEvent` and a `DebtPayoffEvent` name no person,
  so no death bounds them and they stay valid. A job's START is what a death can strand; its END is
  not refused but CLAMPED at run time by `personActiveWindow`.

  Both planes run it on the state they would produce, at their single write: `withStatePlan` for the
  plan plane (so `updatePlan` and every plan-job edit pass through it) and `appendEvent` /
  `replaceEvent` for the ledger plane (so `reviseTransaction` and every authoring verb do). Guarding
  the APPEND as well as the edit is what keeps the invariant true of every authored state — without
  it a household that booked a posthumous loan would be refused every later edit for carrying it.
  Lowering either party's `lifeExpectancy` or moving either `birthYear` under one of these is
  refused and moves nothing; an edit that keeps everything reachable still lands, and a household
  with nothing far-future is untouched — lowering an expectancy stays an ordinary edit.

- **The simulation keeps its own horizon clamp anyway.** With both authoring doors closed, a
  posthumous separation can now only arrive by RESTORATION — a file from another build, hand-edited,
  or exported before the rule existed. Refusing a whole imported file over one stranded separation
  would leave the user nothing to open and no way to fix it, so `restore` stays out of it and
  `memberHorizonReach` models such a household sensibly instead. That is also the door the horizon
  regression tests come through, since authoring can no longer produce the state they test.

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
  nobody outlives them, a younger partner (at their own stated expectancy) when they do, and
  ignores a separated partner.
- **End-to-end:** `scenarios.test.tsx` renders the real panel — a younger partner makes the survival
  sentence read "Sam's life expectancy (age 85)", a same-age partner keeps "your life expectancy".
- All values were observed in the REPL (`npm run repl`) before being pinned, per `AGENTS.md`.

## Changes made

Engine:
- `plan/person.ts` — optional `lifeExpectancy`.
- `job/personActiveWindow.ts` (NEW) — `PersonActiveWindow`, `personActiveWindow`, plus
  `lifeExpectancyEndMonthExclusive` / `membershipWindow` / `memberHorizonReach` moved here from
  `job/householdJob.ts`.
- `job/householdJob.ts` — `resolveHouseholdJob` / `resolveJobPayDisplay` intersect the active
  window, so an employment ends at `min(authored end, death)`.
- `projection/simulate.types.ts`, `compile/compilePerson.ts` — `SimPerson.activeWindow`,
  `isPersonActiveAt`.
- `projection/simulate.ts` — one active-window gate over the month's income series, shared by the
  covered-earnings fold and the waterfall.
- `projection/governmentBenefit.ts` — benefit stops at the window, one check rather than two.
- `projection/buildHouseholdInput.ts` — horizon = max member reach; thread each member's life-end.
- `compile/projectionBase.ts` — primary's expectancy on the standing Person.
  (`LedgerBaseConfig.householdLifeExpectancyAge` was added and then REMOVED: it was named for a
  household, held one person's value, and became unnecessary once every Person states their own.)
- `authoring/relationships.ts` — `marry`/`startPartnered` accept and validate `lifeExpectancy`.
- `retirement/retirementTypes.ts`, `retirement/retirementSolver.ts` — `HorizonAnchor` +
  `horizonAnchorOf`, added to `RetirementSolution`.

App:
- `components/retirementPanel/retirementPanel.tsx` — `LifeExpectancy` helper names the anchor member
  at the five life-expectancy sites.
- `retirementView.ts` — exposes `horizonAge` / `horizonMemberName` from the solution.

## Verification & testing

`npm run typecheck` clean, engine purity clean, **130 test files / 1906 passed / 45 todo** across
engine and app. Every pinned value was observed in the REPL (`npx tsx repl.ts`) first, per
`AGENTS.md`.
