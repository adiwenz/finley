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

/** Calendar year the sample-plan solver tests freeze "now" at (mirrors the app's START_YEAR). */
export const SAMPLE_START_YEAR = 2026;

export const samplePlan = {
  name: "Sample",
  incomeCents: dollarsToCents(8000),
  expenseCents: dollarsToCents(4000),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(20000),
  savingsReturnPct: 5,
  retirementReturnPct: 6,
  brokerageReturnPct: 6,
  retirementDeferralPct: 10,
  sharedScheme: "proportional",
  surplusSwept: true,
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
  currentAge: 40,
  careerStartAge: 18,
  retirementAge: 60,
  lifeExpectancy: 85,
  ssClaimingAge: 67,
} satisfies Plan;

const BARISTA_CURRENT_AGE = 45;
const BARISTA_BIRTH_YEAR = SAMPLE_START_YEAR - BARISTA_CURRENT_AGE;

/**
 * A "barista retirement" fixture (§5): a high-earning **open-ended** job (the `null`-end
 * job, ending at `retirementTargetAge`) plus a low-earning **fixed-term** ("barista") job
 * that keeps paying long past the open-ended job's end. It exists to pin the two §5 solver
 * outputs *distinctly*: the partial retirement age (drop the open-ended job, keep the
 * barista + SS + assets) lands earlier than the full retirement age (cease ALL jobs, incl.
 * the barista, and survive on SS + assets alone). Uses jobs, not scalar `incomeCents`.
 */
const baristaOpenEndedJob: Job = {
  id: "main",
  owners: ["p1"],
  startYear: BARISTA_BIRTH_YEAR + 25,
  endYear: null, // open-ended — ends at retirementTargetAge, the solver varies it
  salary: { startingSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
};

const baristaSupplementalJob: Job = {
  id: "barista",
  owners: ["p1"],
  startYear: SAMPLE_START_YEAR,
  endYear: BARISTA_BIRTH_YEAR + 75, // fixed-term — keeps paying past the open-ended job's end
  salary: { startingSalaryCents: dollarsToCents(30000), realGrowthPct: 0 },
};

export const baristaPlan = {
  name: "Barista",
  incomeCents: 0, // income comes from jobs, not the scalar lever
  expenseCents: dollarsToCents(5500),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(200000),
  savingsReturnPct: 5,
  retirementReturnPct: 6,
  brokerageReturnPct: 6,
  retirementDeferralPct: 0,
  sharedScheme: "proportional",
  surplusSwept: true,
  goals: [],
  healthMonthlyCents: dollarsToCents(600),
  postCoverageHealthMonthlyCents: dollarsToCents(400),
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: BARISTA_CURRENT_AGE,
  careerStartAge: 25,
  retirementAge: 60,
  lifeExpectancy: 90,
  ssClaimingAge: 67,
  jobs: [baristaOpenEndedJob, baristaSupplementalJob],
} satisfies Plan;
