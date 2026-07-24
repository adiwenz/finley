/**
 * A small, purpose-built plan fixture for engine-native mapping/solver tests.
 *
 * Deliberately NOT a copy of the app's `PLAN_DEFAULTS` — copying it would let the
 * two drift silently and couple engine tests to a product default. This is a
 * minimal, self-contained scenario (single household, one goal) chosen so the
 * mapping wiring is easy to assert: a clear surplus to accumulate, a retirement
 * age below the health-coverage age (so the health step is exercised), and a
 * finite horizon.
 *
 * Written with `satisfies Plan` rather than a `: Plan` annotation so the fixture is
 * checked against the type without widening: tests still see each field's literal
 * value, and a drift in `Plan` fails here rather than at a use site. Pure (satisfies
 * `check-engine-purity`) and NOT barrel-exported: tests import it by relative path
 * (`../testing/samplePlan`).
 */
import type { Plan } from "../plan";
import type { Job } from "../job";
import { dollarsToCents } from "../cashFlowSeries";
import { RETIREMENT_ID } from "../projectionBase";

/** Calendar year the sample-plan solver tests freeze "now" at (mirrors the app's START_YEAR). */
export const SAMPLE_START_YEAR = 2026;

const SAMPLE_CURRENT_AGE = 40;
const SAMPLE_START_AGE = 18;

/**
 * A single open-ended, flat-salary {@link Job} that reproduces the old scalar income
 * lever exactly: a real-flat salary (`realGrowthPct: 0` → grows at CPI nominally, holding
 * constant in real terms) anchored in the past so it pays from "now", ending at the
 * owner's `retirementTargetAge`. `startAge` sets the job's `startYear` (which seeds the
 * pre-"now" covered-earnings record, §4.6), and an optional deferral rides on the job
 * (§11). This is the fixture equivalent of the deleted `incomeCents` / `careerStartAge` /
 * `retirementDeferralPct` scalar fields — but it is just one job, in no way privileged;
 * a fixture can hold several (see {@link baristaPlan}).
 */
export function salariedJob(
  monthlyIncomeCents: number,
  opts?: {
    currentAge?: number;
    startAge?: number;
    deferralFraction?: number;
  },
): Job {
  const currentAge = opts?.currentAge ?? SAMPLE_CURRENT_AGE;
  const startAge = opts?.startAge ?? SAMPLE_START_AGE;
  const birthYear = SAMPLE_START_YEAR - currentAge;
  const deferralFraction = opts?.deferralFraction ?? 0;
  return {
    id: "job-main",
    ownerId: "p1",
    startYear: birthYear + startAge,
    endYear: null,
    salary: { startingSalaryCents: monthlyIncomeCents * 12, realGrowthPct: 0 },
    ...(deferralFraction > 0
      ? { deferral: { deferralFraction, fundAccountId: RETIREMENT_ID } }
      : {}),
  };
}

export const samplePlan = {
  name: "Sample",
  expenseCents: dollarsToCents(4000),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(20000),
  savingsReturnPct: 5,
  retirementReturnPct: 6,
  brokerageReturnPct: 6,
  sharedScheme: "proportional",
  goals: [
    {
      id: "emergency",
      name: "Emergency fund",
      targetCents: dollarsToCents(20000),
      targetDate: 24,
      disposition: "retain",
      annualReturnPct: 4,
    },
  ],
  healthMonthlyCents: dollarsToCents(600),
  postCoverageHealthMonthlyCents: dollarsToCents(400),
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: SAMPLE_CURRENT_AGE,
  retirementAge: 60,
  lifeExpectancy: 85,
  benefitClaimingAge: 67,
  jobs: [salariedJob(dollarsToCents(8000), { deferralFraction: 0.1 })],
} satisfies Plan;

const BARISTA_CURRENT_AGE = 45;
const BARISTA_BIRTH_YEAR = SAMPLE_START_YEAR - BARISTA_CURRENT_AGE;

/**
 * A "barista retirement" fixture (§5): a high-earning **open-ended** job (the `null`-end
 * job, ending at `retirementTargetAge`) plus a low-earning **fixed-term** ("barista") job
 * that keeps paying long past the open-ended job's end. It exists to pin the two §5 solver
 * outputs *distinctly*: the partial retirement age (drop the open-ended job, keep the
 * barista + government benefit + assets) lands earlier than the full retirement age (cease ALL
 * jobs, incl. the barista, and survive on government benefit + assets alone). Uses jobs, not
 * scalar `incomeCents`.
 */
const baristaOpenEndedJob: Job = {
  id: "main",
  ownerId: "p1",
  startYear: BARISTA_BIRTH_YEAR + 25,
  endYear: null, // open-ended — ends at retirementTargetAge, the solver varies it
  salary: { startingSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
};

const baristaSupplementalJob: Job = {
  id: "barista",
  ownerId: "p1",
  startYear: SAMPLE_START_YEAR,
  endYear: BARISTA_BIRTH_YEAR + 75, // fixed-term — keeps paying past the open-ended job's end
  salary: { startingSalaryCents: dollarsToCents(30000), realGrowthPct: 0 },
};

export const baristaPlan = {
  name: "Barista",
  expenseCents: dollarsToCents(5500),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(200000),
  savingsReturnPct: 5,
  retirementReturnPct: 6,
  brokerageReturnPct: 6,
  sharedScheme: "proportional",
  goals: [],
  healthMonthlyCents: dollarsToCents(600),
  postCoverageHealthMonthlyCents: dollarsToCents(400),
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: BARISTA_CURRENT_AGE,
  retirementAge: 60,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
  jobs: [baristaOpenEndedJob, baristaSupplementalJob],
} satisfies Plan;
