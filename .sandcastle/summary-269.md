# Summary — Issue #269: Engine cleanup

## Overview

Four frictions made this repo harder to work in than it should be, and this branch addresses all
four:

1. **The engine root was a junk drawer** — 35 files sat flat at `packages/engine/src/`, mixing
   high-fan-in vocabulary, domain models, the authoring→sim compilers, the retirement cluster and
   the declarative input layer.
2. **The facade carried members nothing could reach** — six write members on `Projection` were
   dead: unreferenced in production, live only in tests.
3. **`projectionFacade.test.ts` was 3311 lines of regression armor** while the genre worth growing
   — whole-sentence scenario tests through the real facade and real panels — was starving.
4. **Local agent sessions wrote throwaway Python probes instead of tests** — a Python script cannot
   import `@finley/engine`, so it can only reimplement the arithmetic and confirm its own model.

The fix was staged across 20 tasks so the branch is green at every commit: write the exploration
rule down first (1–3), shrink the facade caller-first (4–10), move files into concept folders
(11–15), then reorganize and grow the tests (16–20).

## Key Decisions & Why

- **Exploration rule = observe through the REPL, then pin as a test** (tasks 1–3). The rule is
  written into `AGENTS.md` and mirrored into the Sandcastle implement prompt, and pinned by
  `comments.guard.test.ts` so deleting it fails a test. `repl.ts`/`playground.ts` became the
  sanctioned observation surface — `npm run repl` works, and the REPL grew thin read-only
  formatters (`dumpMonths`, `waterfall`, `balances`) that format a `ProjectionResult` but never
  compute one, so the REPL can never become a second implementation of the engine.
- **The six dead facade members were provably redundant, not merely unused** (tasks 4–10).
  `JobInput = Omit<Job, "id" | "ownerId">` and `resolveJobInput` is a bare spread, so `replaceJob`
  can produce any job shape the deleted setters could. Every caller was moved onto
  `replaceJob`/`replacePartnerJob` before deletion; the app's `planFixtures.ts` builders kept their
  exact signatures so none of their 11 call sites moved. A reachability guard now catches the next
  dead member the day it dies.
- **Concept folders, not a flat root** (tasks 11–15): `retirement/`, `compile/`, `input/` were
  added and the high-fan-in vocabulary left where it is. Pure file moves, no behaviour change; the
  purity script was hardened for nested folders first.
- **Scenario tests grew in three directions** (tasks 16–20): the shared harness moved into
  `packages/app/src/testing/scenarioBuilders.tsx`, `projectionFacade.test.ts` split into seven
  files by capability, and scenarios grew — more households, sentence-assertion extended to the
  goals / net-worth / base-adjustments panels, and (this task) long-arc life timelines.

## This task (20) — life-timeline scenarios

`packages/app/src/scenarios.lifeTimeline.test.tsx` (new, node env) authors ONE household across
decades — a partner already a decade in, a child already born, a home bought, a loan taken, a
separation, a retirement answer read at the end — and asserts the projection stays coherent across
the whole arc: composition, obligations and balances all agree after every transaction has landed,
not just after each alone.

- The claim seam is unchanged from the other scenarios — what the household is TOLD (the retirement
  headline) — with intermediate state asserted through public reads on `ProjectionResult`
  (`membersAt`, `snapshot`) rather than engine internals.
- The arc exercises the four facade doors no other facade test reached: `startPartnered`,
  `haveExistingChild`, `deferralLimitCrossing`, and `jobStartingMonthlyIncomeCents`. Alex's job
  carries two distinct salary anchors ($84k historical, $120k current) so the starting-income door
  demonstrably reads the past, and a 25% deferral so the $30k it puts away tops the elective limit
  and the crossing door has a year to name.
- `ALEX_BIRTH` was promoted to an export on the shared builders so a partner authored at the same
  age names it directly.

## RGR Verification Details

Every scenario assertion was pinned by observation, never hand-computed: the test was written with
placeholder expectations, run against the real `@finley/engine` under vitest, and the RED diff read
for the true value before pinning it. The retirement headline (`You can retire at 47 and have the
portfolio last to age 90.`) and the deferral crossing year (`START_YEAR`, since 25% of $120k = $30k
already tops the ~$24,500 limit) were both taken from the failing run's output. The three
structural tests (composition, balances, historical-income) passed on first authoring because their
expected values come from independent sources — the names and salaries authored into the arc.

## Changes Made

- **`packages/app/src/scenarios.lifeTimeline.test.tsx`** (new) — five `it`s: household composition
  across arrivals/departures, both debts + the home carried at once while solvent, the retirement
  headline after the whole arc, the deferral-limit crossing year, and the starting-income anchor
  read distinct from current pay.
- **`packages/app/src/testing/scenarioBuilders.tsx`** — `ALEX_BIRTH` now exported.

## Verification & Testing

- `npm run check:purity` — passed.
- `npm run typecheck` — passed.
- `npm run test` — **1820 passed | 45 todo** across 128 files. The 5 new tests are the only change
  to the count in this task; the whole issue's only net removal was the two `setJobDeferralFraction`
  asymmetry tests deleted in task 5, whose behaviour a later task removed.
