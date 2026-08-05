# Handoff — issue 267

Whole-issue mode (issue declares no tasks). The issue has two separable parts; I split it so
each lands green.

**My breakdown:**

- **Part 1 — Disclose the horizon (retirement panel copy). DONE (this commit).** Every
  life-expectancy mention in the retirement panel was a bare "age 90" with no possessive, reading
  as a household guarantee. Now a module-level `LifeExpectancy` helper renders "your life
  expectancy (age 90)" at all five sites (authored-survival both ways, the two headline survival
  clauses, the infeasible line). See `packages/app/src/components/retirementPanel/retirementPanel.tsx`.
- **Part 2 — Give `Person` a `lifeExpectancy`; horizon = max across members. REMAINING.** The real
  fix. Not started.

## Live constraints

- **The design decision that unblocks Part 2 is in the issue comments** (`gh issue view 267
  --comments`): horizon becomes the **max across all members' life expectancies**; a member's own
  expectancy bounds only **their** income/benefit window; **household spending (`budgetLines`) does
  NOT step down** when a member's expectancy passes — it runs unchanged to the extended horizon.
  Budget attribution (per-member spending) stays out of scope. Follow this decision exactly.
- **Horizon is computed in the wrong layer for Part 2.** `createProjectionBase`
  (`packages/engine/src/compile/projectionBase.ts:267`) sets `horizonMonths = planHorizonMonths(budget)`
  from the PRIMARY only (`budget.currentAge`/`budget.lifeExpectancy`). It takes only `plan` + `ctx`,
  never the ledger — but partners join via `RelationshipEvent` in `scenario.ledger`
  (`packages/engine/src/ledger/eventTypes.ts:47`, which carries a full `Person`). To make the
  horizon max-across-members, the max must be computed where BOTH the plan and the ledger are in
  scope: `projectScenarioParts` in `packages/engine/src/retirement/retirementSolver.ts:71`. Also
  audit the other `createProjectionBase` callers (deferralLimit.ts, retirementSolver.ts:291/342,
  eventWrite.ts) and `planHorizonMonths` consumers — `computeOnTrackFraction`
  (retirementSolver.ts:180) recomputes the horizon from the primary and must stay consistent.
- **`Person` is the seam for the new field.** Add `readonly lifeExpectancy` to `Person`
  (`packages/engine/src/plan/person.ts`). The primary holds no `Person` record — its standing data
  IS the `Plan`, and `createProjectionBase` builds the primary `Person` from `budget` (see
  projectionBase.ts:233). So the primary's expectancy is still `plan.lifeExpectancy`; only partners
  need it on their `Person`. `AGE_LIMITS.lifeExpectancy` (plan.ts) already bounds the scalar; a
  per-person one may need the same guard in event validation.
- **Government benefit window** — the member-expectancy bound is "the same window #266's
  separated-partner window" uses. Look at `packages/engine/src/projection/governmentBenefit.ts` and
  how a member's presence window is derived; a member's benefit must stop at their expectancy.
- **Solver / `plannedWorkStopAge` report in the PRIMARY's years throughout** (retirementView.ts,
  retirementSolver.ts). Keep that; don't accidentally reframe the headline onto a partner's clock.
- **Part 1's panel copy will need revisiting in Part 2.** `LifeExpectancy` currently says "your"
  (the primary's). Once the horizon can be driven by a partner's (older) expectancy, the copy must
  name **whichever member drives the horizon**, not always "you". The panel today receives only
  `view` + `budget` and has no member roster — Part 2 must thread whose-expectancy through.

## Dead ends

- None yet.

## Deferred

- Per-member budget attribution / spending step-down at a member's death — explicitly out of scope
  by the issue's design decision. A follow-up, not this issue.
