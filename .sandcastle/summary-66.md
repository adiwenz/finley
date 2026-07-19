# Slice 3 — `retirementTargetAge` input + two solver outputs (career-exit / work-optional)

**Issue:** #66 · **Branch:** `sandcastle/issue-66` · Part of #63 (Jobs & household redesign), §5.

## Overview

Retirement is now modelled as a person-level **input** distinct from **two solver
outputs**, all running off the real §5 projection (the same `simulateHousehold` the
net-worth graph draws — #37/#29 substrate):

- **`retirementTargetAge`** (per-person input) = career exit = when the career
  (`null`-end) job ends.
- **Career-exit age** (solver output 1) — vary the career job's end; keep authored
  supplemental jobs + passive income + SS.
- **Work-optional age** (solver output 2) — cease **ALL** jobs (career + supplemental)
  and survive on passive income + SS + assets alone. Always ≥ the career-exit age.
- **Full-work-stop target** — the derived `max(job endYears)` as an age.

The two ages come off one plan via the new `solveRetirement(plan, ctx)`; a "barista
retirement" plan solves them **distinctly**.

## RGR Verification Details

- **RED:** Added a `baristaPlan` fixture (career job to `retirementTargetAge`, plus a
  supplemental "barista" job paying past it) and a new `describe` block in
  `retirementSolver.test.ts` referencing `earliestCareerExitAge`,
  `earliestWorkOptionalAge`, `evaluateWorkOptionalAtAge`, and `solveRetirement`.
  `npx vitest run` reported **5 failing** (imports/exports did not yet exist).
- **GREEN:** Implemented the two-solver API in `retirementSolver.ts` + the
  `RetirementSolution` type in `retirementTypes.ts`. Same command → **11 passing**.
- **Empirical check:** On the barista fixture the solver returns career-exit **56** and
  work-optional **59** — distinct, with work-optional strictly later, and work-optional
  survival verified monotonic in the cease-all-work age (so the binary search is valid).
- **REFACTOR:** Extracted the shared monotonic binary search into
  `earliestSurvivingAge(budget, survives)`, reused by both the career-exit and
  work-optional searches (they differ only in the per-age projection).

## Key Decisions & Why

- **Career-exit == the existing feasibility search, renamed.** The historical
  `earliestFeasibleRetirementAge` already varies only the career job's end (via
  `retirementTargetAge`) while every supplemental job keeps its authored span. Rather
  than duplicate it, `earliestCareerExitAge` is a §5-named alias, and a test pins the
  two equal so they can never drift.
- **Work-optional = cap every job's end at the pinned age.** `ceaseAllJobsAtAge` resolves
  each job's exclusive end (`null`-end → `birthYear + retirementTargetAge`), then caps it
  at the calendar year the owner turns `age`. This never *extends* a job (a supplemental
  job ending earlier keeps its end) and leaves only explicit ends, so `retirementAge` no
  longer moves any of them. Passive income (a future stream, §17) is by construction not
  a job, so it would survive this transform untouched.
- **Same substrate, one search.** Both ages run through `projectPlan`/`realNetWorthSurvives`,
  so the panel and the graph cannot disagree. Survival is monotonic in both the career-exit
  age and the cease-all-work age (working/holding jobs longer never hurts), so one shared
  binary search serves both — O(log range) projections each.
- **`fullWorkStopTargetAge`** is the derived `max(job endYears)` as an age; `null` for a
  scalar (jobs-less) plan, whose earned income already stops at `retirementAge`.
- **Fixture over product default.** The barista scenario lives in `testing/samplePlan.ts`
  (not copied from the app's `PLAN_DEFAULTS`), consistent with the existing engine-test
  discipline, and is exported for reuse.

## Changes Made

- **`packages/engine/src/retirementTypes.ts`** — new `RetirementSolution` interface
  (`careerExitAge`, `workOptionalAge`, `fullWorkStopTargetAge`).
- **`packages/engine/src/retirementSolver.ts`**
  - Extracted `earliestSurvivingAge(budget, survives)` (shared monotonic binary search);
    `earliestFeasibleRetirementAge` now delegates to it.
  - `earliestCareerExitAge` — §5-named alias of the feasibility search.
  - `ceaseAllJobsAtAge` (private), `projectWorkOptional`, `evaluateWorkOptionalAtAge`,
    `earliestWorkOptionalAge` — the work-optional path.
  - `fullWorkStopTargetAge` and `solveRetirement` — the combined two-output entry point.
  - Module docstring updated to frame the two §5 solvers.
- **`packages/engine/src/testing/samplePlan.ts`** — `SAMPLE_START_YEAR` constant and the
  exported `baristaPlan` fixture (career + supplemental jobs).
- **`packages/engine/src/retirementSolver.test.ts`** — new `describe` block covering the
  two solvers: alias equality, work-optional monotonicity, work-optional threshold search,
  the barista distinctness AC, and the full-work-stop target.
- **`packages/engine/src/job.test.ts`** — added a test pinning AC1: `retirementTargetAge`
  is the per-person input that sets the compiled career job's forward-income end.
- New solver functions/types are barrel-exported automatically (`export * from`).

## Acceptance Criteria

- [x] `retirementTargetAge` is a per-person input that sets the career job's end — `job.test.ts`.
- [x] Career-exit solver varies the career-job end, keeping supplemental + passive — `earliestCareerExitAge`.
- [x] Work-optional solver finds the age all jobs can stop (real terms) — `earliestWorkOptionalAge`.
- [x] Both solvers run off the real §5 projection (per #29), not the standalone scenario.
- [x] A barista-retirement plan solves both ages distinctly — `retirementSolver.test.ts`.

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` → **425 tests green** (45 todo), 38 test files. Solver + job suites:
  18 green (11 solver, 7 job).
