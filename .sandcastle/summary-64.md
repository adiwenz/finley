# Slice 1 — Job/Person standing model + additive lowering into Household (issue #64)

## Overview

Introduces a first-class `Job` / `Person` standing authoring model and lowers it
into the **existing** derived `Household` income pipeline — **additively**,
alongside the scalar `Plan.incomeCents` / `careerStartAge` / `JobChangeEvent`
path. When a plan carries a non-empty `jobs` list, `createProjectionBase` lowers
the jobs into the base income series + pre-"now" earnings record; otherwise it
falls through to the untouched scalar path. Nothing is removed — the breaking
scalar removal + app migration are #72's job. A single career job authored to
mirror the scalar model reproduces `simulateHousehold` output **month-for-month**.

Traces to `JOBS_HOUSEHOLD_REDESIGN.md` §1–§6, §8 and issue #64's acceptance
criteria + additive guardrails.

## RGR Verification Details

- **RED:** Added `packages/engine/src/job.test.ts`. The discriminating case
  projects `{ ...samplePlan, incomeCents: $1, jobs: [careerJob] }` and asserts it
  equals the scalar `samplePlan` projection. With the lowering branch disabled
  (forced `false`), `createProjectionBase` used the bogus `$1` scalar income →
  the projections diverged → **1 failed | 5 passed** (confirmed by temporarily
  neutralizing the branch condition and re-running).
- **GREEN:** Implemented the `jobs.length ? lowerJobs : scalar` branch in
  `createProjectionBase` plus the pure lowering in `job.ts`. The full `job.test.ts`
  went **6 passed**, and the discriminating test passes because the branch reads
  the jobs, not `incomeCents`.
- **REFACTOR:** Extracted `birthYear`, kept the scalar income/priorEarnings code
  reachable and exercised (empty-jobs and no-jobs plans both flow through it),
  and documented the exact-match reasoning in-source.

## Key Decisions & Why

- **Exact scalar reproduction.** The scalar income series is a *monthly-baseline*,
  `inflationLinked`, real-flat stream running `[0, (retAge-curAge)*12 - 1]`, with
  pre-"now" earnings = today's salary CPI-deflated per past year. A career job
  with `startingSalaryCents = incomeCents*12`, `realGrowthPct = 0`, `startYear =
  now - (currentAge - careerStartAge)`, `endYear = null` lowers to a byte-identical
  series: `round(annualNow/12) = incomeCents`, `inflationLinked` at CPI, ending at
  `retirementTargetAge`. Real-flat salary grows nominally at exactly CPI, so it is
  tagged `inflationLinked` (matching the scalar) rather than a compounded rate.
- **Deferral lives on the job (§11).** The career job carries a `JobDeferral`
  (`deferralFraction` + `fundAccountId` + optional match) that lowers to the same
  `PlanDescriptor` the scalar `retirementDeferralPct` produces. The retirement
  account itself is still minted by `buildPlanAccounts` from the scalar plan.
- **Past earnings computed directly, never simulated (§3, §4.6).**
  `lowerPersonPriorEarnings` sums each job's covered wage for calendar years
  `< now`; the sim still opens at month 0. Verified the job path's
  `priorEarningsCents` equals the scalar `seedPriorEarnings` output and that
  `months[0].month === 0`.
- **`endYear` is exclusive.** A job is worked in `[startYear, endYear)`; the career
  (`null`-end) job's exclusive end is `birthYear + retirementTargetAge`, matching
  the scalar `age < retirementAge`.
- **Naming collision resolved without touching the simulator.** The standing
  `Person` (§8) collides with the lower-level simulator `Person`
  (`./projection/simulate`, imported by the app). Rather than rename the simulator
  type (out of scope; would ripple through app + existing tests), the standing
  type is barrel-exported as **`HouseholdPerson`** (aliased), leaving the app's
  `import { Person }` intact. Unification is #72's job.
- **`≤1 null-end job per person`** enforced by `careerJobOf`, consulted at the top
  of `lowerPersonIncomeSeries` so the invariant bites even if the income result is
  ignored.

## Changes Made

- **`packages/engine/src/job.ts` (new):** `PersonId`, `SalaryTrajectory`,
  `JobDeferral`, `Job`, standing `Person`; `deriveRealGrowthPct` (two-point entry
  mode → real growth), `careerJobOf` (≤1 null-end guard), `lowerPersonPriorEarnings`
  (pure pre-"now" earnings record), `lowerPersonIncomeSeries` (per-job forward
  `OwnedSeries`). Pure, jurisdiction-free.
- **`packages/engine/src/plan.ts`:** added optional `readonly jobs?: readonly Job[]`
  to `Plan` (`incomeCents`, `careerStartAge` left present + required).
- **`packages/engine/src/projectionBase.ts`:** additive
  `jobs.length ? lowerJobs : scalar` branch in `createProjectionBase` for both the
  pre-"now" earnings record and the forward income series; exported `RETIREMENT_ID`
  so a job's deferral can target the same account. Scalar code retained + reachable.
- **`packages/engine/src/index.ts`:** explicit named exports for the job model
  (`Job`, `PersonId`, `SalaryTrajectory`, `JobDeferral`, helpers) with standing
  `Person` aliased to `HouseholdPerson`.
- **`packages/engine/src/job.test.ts` (new):** the month-for-month pin, the
  branch-discriminator, the pre-"now" earnings check, empty-jobs fall-through, the
  ≤1-career-job guard, and `deriveRealGrowthPct`.

## Additive guardrails (verified vs `main`)

- `git diff --stat main -- packages/app` → **empty** (app untouched).
- `Plan.incomeCents` and `Plan.careerStartAge` still present and **required**.
- `JobChangeEvent` still live in `eventTypes.ts`, `eventHandlers.ts`,
  `eventValidation.ts`, and `app/src/ledgerView.ts`.
- No existing engine test modified — new coverage lands only in `job.test.ts`.
- Scalar lowering preserved as a branch (exercised by no-jobs and empty-jobs plans).

## Verification & Testing

- `npm run check:purity` → engine purity passed (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` → **413 passed | 45 todo (458), 37 files**.
- New `job.test.ts` → **6 passed**; RED confirmed (1 failed) with the branch disabled.

## Notes for the next iteration

- The standing `Person`'s person-level inputs (`birthYear`, `retirementTargetAge`,
  `ssClaimingAge`) are still sourced from the scalar `Plan` fields in slice 1;
  full standing-person authoring + the `Projection` facade come in later slices.
- Salary is a single forward `SalaryTrajectory` (v1); multi-segment salary and the
  split forward/back slope are backlog (§ "Deferred / backlog").
- `HouseholdPerson` alias is temporary — #72 unifies it with the simulator `Person`
  and removes the scalar authoring (`incomeCents`, `careerStartAge`,
  `JobChangeEvent`, scalar `createProjectionBase`).
