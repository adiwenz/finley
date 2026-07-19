/**
 * Turns a {@link Plan} (the authored financial values — NOT life events) into the
 * engine's `LedgerBaseConfig` for replay, including the §5.0 waterfall config
 * (goals and the four levers). The account/goal derivation is exported so a goals
 * surface can score the same goals against the projection without duplicating the map.
 *
 * The mapping is pure and jurisdiction-agnostic except for two facts it must be
 * told: the calendar "now" (`startYear`) and the age at which public health
 * coverage begins. Both arrive via {@link ProjectionContext} — the engine cannot
 * read a wall clock, and the coverage age is a jurisdiction fact — so the caller
 * (the app) supplies them.
 */

import { CashFlowSeries } from "./cashFlowSeries";
import { Account, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "./account";
import type { Cents } from "./money";
import type { SimPerson, OwnedSeries, ProjectionSeries } from "./projection/simulate";
import type { Goal, GoalDisposal } from "./goal";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { SurplusDestination } from "./projection/waterfall";
import type { Jurisdiction } from "./jurisdiction";
import type { Plan, GoalPlan } from "./plan";
import { type Person } from "./person";
import { compilePersonIncomeSeries, compilePersonPriorEarnings } from "./compilePerson";

/**
 * The environment + jurisdiction the plan→projection mapping is resolved against.
 * The engine is pure and cannot read a wall clock, so `startYear` (the frozen
 * "now") is supplied by the caller rather than derived; the `jurisdiction` carries
 * the readable facts the mapping needs (notably {@link
 * Jurisdiction.publicHealthCoverageAge} for the health step).
 */
export interface ProjectionContext {
  /** The jurisdiction whose readable facts the mapping resolves against. */
  readonly jurisdiction: Jurisdiction;
  /** Calendar year of month 0 — the frozen "now". App-supplied environment, not a plan field. */
  readonly startYear: number;
}

/** The primary (and, in this slice, only) household member. */
export const PRIMARY_PERSON_ID = "p1";
const SAVINGS_ID = "savings";
/** The pre-tax retirement account a deferral (scalar lever or a {@link Job}) funds. */
export const RETIREMENT_ID = "retirement";
const BROKERAGE_ID = "brokerage";

/** The fund account a goal accumulates into (one per goal, so goals don't share a balance). */
export function goalFundAccountId(goal: GoalPlan): string {
  return `goal-${goal.id}`;
}

/**
 * Every account implied by the plan: the liquid savings account, the pre-tax
 * retirement account (funded by the deferral lever), the sweep-target brokerage,
 * and one fund account per goal. All non-liquid accounts carry the plan's return
 * rate, which is what makes near-term goals in them trip the §5.2 risk flag.
 */
export function buildPlanAccounts(budget: Plan): Account[] {
  const accounts: Account[] = [
    new Account({
      id: SAVINGS_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: true,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: budget.openingBalanceCents,
      initialAnnualRate: budget.savingsReturnPct / 100,
    }),
    new Account({
      id: RETIREMENT_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: budget.retirementReturnPct / 100,
    }),
    new Account({
      id: BROKERAGE_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: budget.brokerageReturnPct / 100,
    }),
  ];
  for (const goal of budget.goals) {
    accounts.push(
      new Account({
        id: goalFundAccountId(goal),
        ownerId: PRIMARY_PERSON_ID,
        liquid: false,
        taxProfile: CAPITAL_GAINS_TAX_PROFILE,
        openingBalanceCents: 0,
        initialAnnualRate: goal.annualReturnPct / 100,
      }),
    );
  }
  return accounts;
}

/**
 * The plan's goals as engine `Goal`s. Array order is priority (index 0 first),
 * so reordering the plan array reprioritizes without touching anything else.
 */
export function buildPlanGoals(budget: Plan): Goal[] {
  return budget.goals.map((goal, i) => {
    // The disposition/targetDate pair travels as ONE value: naming the fields
    // separately here would let a `spend`/`convertToEquity` goal pick up an "asap"
    // date that the plan type forbids (§5.2, {@link GoalDisposal}).
    const disposal: GoalDisposal = goal;
    return {
      id: goal.id,
      name: goal.name,
      targetCents: goal.targetCents,
      fundAccountId: goalFundAccountId(goal),
      priority: i,
      scope: "shared" as const,
      ...disposal,
    };
  });
}

/**
 * The health expense line (§5.4), additive to the general expense and growing at
 * its own configurable rate (`healthInflationPct`) — so a plan can model medical
 * costs rising faster than general inflation, but need not; it carries whatever
 * `customRate` the user sets rather than being pinned to CPI. When the plan enrols
 * in public coverage and the jurisdiction has a `publicHealthCoverageAge`, the line
 * steps from the pre-coverage self-funded figure down to the authored residual at
 * the month the person reaches that age; both figures are authored in today's
 * dollars and share the same forward inflation, so the residual override is that
 * figure inflated to the coverage age. Not enrolling, a jurisdiction with no
 * coverage age, or already being past it, collapses to a single segment.
 */
function buildHealthSeries(budget: Plan, coverageAge: number | undefined): CashFlowSeries {
  const rate = budget.healthInflationPct / 100;
  const growth = { type: "customRate" as const, annualRate: rate };
  // The step exists only when the plan enrols AND the jurisdiction offers a
  // coverage age; without one there is no public coverage to step down to.
  const enrolls = budget.enrollsInPublicHealthCoverage && coverageAge !== undefined;
  if (!enrolls) {
    return new CashFlowSeries(0, budget.healthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }
  const yearsToCoverage = coverageAge - budget.currentAge;

  // Already at/past the coverage age → the residual applies from month 0.
  if (yearsToCoverage <= 0) {
    return new CashFlowSeries(0, budget.postCoverageHealthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }

  const series = new CashFlowSeries(0, budget.healthMonthlyCents, growth, {
    baselineUnit: "monthly",
  });
  // Step down at the coverage age: the residual (today's dollars) inflated forward
  // to that month, then it keeps growing at the same rate from its own anchor.
  const nominalResidualAtCoverage = Math.round(
    budget.postCoverageHealthMonthlyCents * Math.pow(1 + rate, yearsToCoverage),
  );
  series.addOverride(yearsToCoverage * 12, nominalResidualAtCoverage, "fromHereForward", {
    newGrowthMode: growth,
    resetAnchor: true,
  });
  return series;
}

/**
 * Nominal SS-covered earnings for the working ages in `[fromAge, toAge)`, assuming
 * a constant *real* (today's) salary across the whole span: each year is today's
 * salary inflated to that calendar year at CPI, keyed by calendar year. Consistent
 * with how in-model income is modelled (inflation-linked, flat in real terms). Both
 * the pre-"now" record seed and the panel's benefit calc read from this shape.
 */
function careerEarningsCents(
  budget: Plan,
  startYear: number,
  fromAge: number,
  toAge: number,
): Record<number, Cents> {
  const annualSalaryNow = budget.incomeCents * 12;
  const inflationRate = budget.inflationPct / 100;
  const earnings: Record<number, Cents> = {};
  for (let age = fromAge; age < toAge; age++) {
    const year = startYear + (age - budget.currentAge); // < startYear for ages before "now"
    earnings[year] = Math.round(annualSalaryNow * Math.pow(1 + inflationRate, age - budget.currentAge));
  }
  return earnings;
}

/**
 * The full nominal SS-covered earnings record the plan implies — the whole career,
 * from the authored career start age through retirement. The panel prices Social
 * Security from this same record the graph accumulates, so both surfaces report the
 * same benefit.
 */
export function fullCareerEarningsCents(budget: Plan, startYear: number): Record<number, Cents> {
  return careerEarningsCents(budget, startYear, budget.careerStartAge, budget.retirementAge);
}

/**
 * Reconstruct the person's SS-covered earnings for the working years BEFORE the
 * simulation starts (the §4.6 pre-"now" summary the engine seeds from).
 *
 * Why this is needed even for someone who will work a "full" 30 years in-model:
 * the AIME formula (§5.4) sums a worker's highest 35 indexed years and always
 * divides by a fixed 420-month (35-year) window. A 35-year-old who retires at 65
 * only earns 30 in-model years, so 5 slots would be counted as $0 and drag the
 * benefit down ~1/7. A real 35-year-old has instead been earning since the age
 * they started their career, and those years fill the record — so we seed ages
 * {@link Plan.careerStartAge} → today.
 */
function seedPriorEarnings(budget: Plan, startYear: number): Record<number, Cents> {
  return careerEarningsCents(budget, startYear, budget.careerStartAge, budget.currentAge);
}

export function createProjectionBase(budget: Plan, ctx: ProjectionContext): LedgerBaseConfig {
  const { startYear } = ctx;
  // Give the projection an SS basis (§5.4): a birth year derived from today's age
  // plus the pinned claiming age, so the engine accumulates earnings while working
  // and pays a Social Security benefit from the claiming age — the same lever the
  // retirement panel reasons about, now present in the graph too. Seed the years
  // worked BEFORE "now" so the benefit reflects a full career, not just in-model
  // earnings (see seedPriorEarnings).
  const inflationRate = budget.inflationPct / 100;
  const birthYear = startYear - budget.currentAge;

  // Additive branch (§1, issue #64): a non-empty jobs list is the new source of
  // truth for earned income — compile the standing Job model; otherwise fall through
  // to the scalar `incomeCents`/`careerStartAge` path (still live until #72). Both
  // produce the same shapes (pre-"now" earnings record + forward income series),
  // so the rest of the base build is identical.
  const standingPerson: Person | undefined =
    budget.jobs != null && budget.jobs.length > 0
      ? {
          id: PRIMARY_PERSON_ID,
          name: budget.name,
          birthYear,
          retirementTargetAge: budget.retirementAge,
          ssClaimingAge: budget.ssClaimingAge,
          jobs: budget.jobs,
        }
      : undefined;

  // Give the projection an SS basis (§5.4): a birth year derived from today's age
  // plus the pinned claiming age, so the engine accumulates earnings while working
  // and pays a Social Security benefit from the claiming age — the same lever the
  // retirement panel reasons about, now present in the graph too. Seed the years
  // worked BEFORE "now" so the benefit reflects a full career, not just in-model
  // earnings (from jobs directly when present, else the scalar seedPriorEarnings).
  const person: SimPerson = {
    id: PRIMARY_PERSON_ID,
    name: budget.name,
    birthYear,
    ssClaimingAge: budget.ssClaimingAge,
    priorEarningsCents: standingPerson
      ? compilePersonPriorEarnings(standingPerson, startYear, inflationRate)
      : seedPriorEarnings(budget, startYear),
  };

  // Income runs until retirement then stops (§7); while working it grows with CPI,
  // so it holds constant in real terms rather than eroding against rising prices.
  const workingMonths = Math.max(0, (budget.retirementAge - budget.currentAge) * 12);
  const incomeSeries = new CashFlowSeries(
    0,
    budget.incomeCents,
    { type: "inflationLinked", annualRate: inflationRate },
    { baselineUnit: "monthly", endMonth: workingMonths - 1 },
  );
  // General (non-health) expenses also grow with CPI — flat in real terms.
  const expenseSeries = new CashFlowSeries(
    0,
    budget.expenseCents,
    { type: "inflationLinked", annualRate: inflationRate },
    { baselineUnit: "monthly" },
  );
  // Value edits are overrides on the artifact — never life events (§10.3 rule 1).
  for (const o of budget.expenseOverrides) {
    expenseSeries.addOverride(o.month, o.monthlyCents, o.scope);
  }

  const healthSeries = buildHealthSeries(budget, ctx.jurisdiction.publicHealthCoverageAge);

  // Lever 1 (§5.5): a positive deferral % turns the income into a plan-bearing
  // source that defers pre-tax into the retirement account.
  const income: OwnedSeries = {
    series: incomeSeries,
    ownerId: PRIMARY_PERSON_ID,
    planDescriptor:
      budget.retirementDeferralPct > 0
        ? { deferralFraction: budget.retirementDeferralPct / 100, fundAccountId: RETIREMENT_ID }
        : undefined,
  };

  // Jobs present → compile each job into its own forward income series; else the
  // single scalar income source. Deferral rides on the job (§11) in the job path.
  const initialIncomeSeries: readonly OwnedSeries[] = standingPerson
    ? compilePersonIncomeSeries(standingPerson, startYear, inflationRate)
    : [income];

  const surplusDestination: SurplusDestination = budget.surplusSwept
    ? { kind: "swept", accountId: BROKERAGE_ID }
    : { kind: "idle" };

  return {
    horizonMonths: Math.max(0, (budget.lifeExpectancy - budget.currentAge) * 12),
    annualInflationRate: inflationRate,
    startYear,
    initialPersons: [person],
    initialAccounts: buildPlanAccounts(budget),
    initialIncomeSeries,
    initialExpenseSeries: [
      { series: expenseSeries, ownerId: PRIMARY_PERSON_ID },
      { series: healthSeries, ownerId: PRIMARY_PERSON_ID },
    ],
    goals: buildPlanGoals(budget),
    sharedScheme: budget.sharedScheme,
    surplusDestination,
  };
}

export function firstInsolventMonth(series: ProjectionSeries): number | null {
  for (const m of series.months) if (m.isInsolvent) return m.month;
  return null;
}
