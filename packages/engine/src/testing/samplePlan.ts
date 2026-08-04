/**
 * A small, purpose-built plan fixture for engine-native mapping/solver tests.
 *
 * NOT a copy of the app's `PLAN_DEFAULTS` — that would drift silently and couple engine tests
 * to a product default. One household, one goal, chosen so the mapping wiring is easy to
 * assert: a clear surplus to accumulate, a retirement age below the health-coverage age
 * (so the early-retiree health check has a gap window to look at), a finite horizon.
 *
 * `satisfies Plan` rather than a `: Plan` annotation type-checks without widening: tests still
 * see each field's literal value, and a drift in `Plan` fails here rather than at a use site.
 * Pure (satisfies `check-engine-purity`) and NOT barrel-exported — tests import it by relative
 * path (`../testing/samplePlan`).
 */
import type { Plan } from "../plan";
import type { Job } from "../job";
import type { BudgetLine } from "../budgetLine";
import type { Ledger } from "../ledger/ledger";
import { emptyLedger } from "../ledger/ledger";
import { CURRENT_FORMAT_VERSION, type ProjectionState } from "../index";
import { dollarsToCents } from "../cashFlowSeries";
import { RETIREMENT_ID } from "../ids";

/**
 * One literal expense line carrying the whole monthly spend. Budget lines are the only expense
 * authoring surface, so a fixture states its spend as a line; a single line inflating with CPI
 * is what the projection charges.
 */
export function spendLine(monthlyCents: number): BudgetLine {
  return {
    id: "spend",
    label: "Spending",
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents },
    category: "needs",
  };
}

/**
 * The fixture's health cost, stated as a line like any other spend. Health used to be a plan
 * field additive to the budget, so it is a second line here rather than folded into
 * {@link spendLine} — the fixture charges what it always charged.
 */
export function healthLine(monthlyCents: number): BudgetLine {
  return {
    id: "health",
    label: "Healthcare",
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents },
    category: "healthcare",
  };
}

/** Calendar year the sample-plan solver tests freeze "now" at (mirrors the app's START_YEAR). */
export const SAMPLE_START_YEAR = 2026;

const SAMPLE_CURRENT_AGE = 40;
/** Where the fixture's job ends unless a test says otherwise — every job states an end. */
const SAMPLE_RETIREMENT_AGE = 60;
const SAMPLE_START_AGE = 18;

/**
 * A single flat-salary {@link Job}: real-flat salary (`realGrowthPct: 0` → grows at CPI
 * nominally, constant in real terms), anchored in the past so it pays from "now", and ending at
 * `endAge`. `startAge` sets the job's `startYear`, which
 * seeds the pre-"now" covered-earnings record; an optional deferral rides on the job. One job,
 * in no way privileged — a fixture can hold several (see {@link baristaPlan}).
 */
export function salariedJob(
  monthlyIncomeCents: number,
  opts?: {
    currentAge?: number;
    startAge?: number;
    deferralFraction?: number;
    /** The age the job is AUTHORED to end at, exclusive. Defaults to the fixture's retirement age. */
    endAge?: number;
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
    endYear: birthYear + (opts?.endAge ?? SAMPLE_RETIREMENT_AGE),
    salary: {
      startingSalaryCents: monthlyIncomeCents * 12,
      currentSalaryCents: monthlyIncomeCents * 12,
      realGrowthPct: 0,
    },
    ...(deferralFraction > 0
      ? { deferral: { deferralFraction, fundAccountId: RETIREMENT_ID } }
      : {}),
  };
}

export const samplePlan = {
  name: "Sample",
  budgetLines: [spendLine(dollarsToCents(4000)), healthLine(dollarsToCents(600))],
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
  inflationPct: 3,
  currentAge: SAMPLE_CURRENT_AGE,
  retirementAge: SAMPLE_RETIREMENT_AGE,
  lifeExpectancy: 85,
  benefitClaimingAge: 67,
  jobs: [salariedJob(dollarsToCents(8000), { deferralFraction: 0.1 })],
} satisfies Plan;

const BARISTA_CURRENT_AGE = 45;
const BARISTA_BIRTH_YEAR = SAMPLE_START_YEAR - BARISTA_CURRENT_AGE;

/**
 * A "barista retirement" fixture: a high-earning career job that ends at 60, plus a low-earning
 * ("barista") job that keeps paying long past it. Both state their own end — the fixture is now
 * about two jobs with different spans, not about two KINDS of job.
 */
const baristaOpenEndedJob: Job = {
  id: "main",
  ownerId: "p1",
  startYear: BARISTA_BIRTH_YEAR + 25,
  endYear: BARISTA_BIRTH_YEAR + 60, // the career job, authored to end at 60
  salary: { startingSalaryCents: dollarsToCents(120000), currentSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
};

const baristaSupplementalJob: Job = {
  id: "barista",
  ownerId: "p1",
  startYear: SAMPLE_START_YEAR,
  endYear: BARISTA_BIRTH_YEAR + 75, // keeps paying long past the career job's end
  salary: { startingSalaryCents: dollarsToCents(30000), currentSalaryCents: dollarsToCents(30000), realGrowthPct: 0 },
};

export const baristaPlan = {
  name: "Barista",
  budgetLines: [spendLine(dollarsToCents(5500)), healthLine(dollarsToCents(600))],
  openingBalanceCents: dollarsToCents(200000),
  savingsReturnPct: 5,
  retirementReturnPct: 6,
  brokerageReturnPct: 6,
  sharedScheme: "proportional",
  goals: [],
  inflationPct: 3,
  currentAge: BARISTA_CURRENT_AGE,
  retirementAge: 60,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
  jobs: [baristaOpenEndedJob, baristaSupplementalJob],
} satisfies Plan;

/**
 * A fixture {@link Plan} (and optional {@link Ledger}) as the `ProjectionState` a handle is
 * restored from — the **adoption boundary**, for tests only.
 *
 * A `Plan` fixture already carries ids, so handing one to the engine is restoration, not
 * authoring: there is deliberately no public API that takes one and calls itself id-free.
 * `Projection.fromState` is where such state comes in, and `nextSeq: 1` means "not known" —
 * the normalization floors both counters past whatever the fixture holds, so a plan holding
 * `goal-1` cannot have a second `goal-1` minted on top of it.
 *
 * Tests that AUTHOR a scenario should use `Projection.fromInput` and capture the ids it
 * returns. This is for the ones that need a handle over a pre-built plan.
 */
export function stateOf(plan: Plan, ledger: Ledger = emptyLedger): ProjectionState {
  return {
    scenario: { plan, ledger },
    startYear: SAMPLE_START_YEAR,
    nextSeq: 1,
    version: CURRENT_FORMAT_VERSION,
  };
}
