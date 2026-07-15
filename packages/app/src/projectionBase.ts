/**
 * Turns the editable plan values (§10.2 — NOT events) into the engine's
 * `LedgerBaseConfig` for replay, including the §5.0 waterfall config (goals and
 * the four levers). The account/goal derivation is exported so the Goals panel
 * can score the same goals against the projection without duplicating the map.
 */

import {
  CashFlowSeries,
  Account,
  type Cents,
  type Person,
  type Goal,
  type LedgerBaseConfig,
  type OwnedSeries,
  type ProjectionSeries,
  type SurplusDestination,
} from "@finley/engine";
import { MEDICARE_ELIGIBILITY_AGE } from "@finley/rules";
import { planHorizonMonths, START_YEAR } from "./config";
import type { BudgetValues, GoalPlan } from "./planTypes";

/** The primary (and, in this slice, only) household member. */
export const PRIMARY_PERSON_ID = "p1";
const SAVINGS_ID = "savings";
const RETIREMENT_ID = "retirement";
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
export function buildPlanAccounts(budget: BudgetValues): Account[] {
  const accounts: Account[] = [
    new Account({
      id: SAVINGS_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: true,
      taxTreatment: "taxable",
      openingBalanceCents: budget.openingBalanceCents,
      initialAnnualRate: budget.savingsReturnPct / 100,
    }),
    new Account({
      id: RETIREMENT_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: false,
      taxTreatment: "preTax",
      openingBalanceCents: 0,
      initialAnnualRate: budget.retirementReturnPct / 100,
    }),
    new Account({
      id: BROKERAGE_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: false,
      taxTreatment: "taxable",
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
        taxTreatment: "taxable",
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
export function buildPlanGoals(budget: BudgetValues): Goal[] {
  return budget.goals.map((goal, i) => ({
    id: goal.id,
    name: goal.name,
    targetCents: goal.targetCents,
    targetDate: goal.targetDate,
    fundAccountId: goalFundAccountId(goal),
    priority: i,
    type: goal.type,
    scope: "shared" as const,
  }));
}

/**
 * The health expense line (§5.4), additive to the general expense and growing at
 * its own configurable rate (`healthInflationPct`) — so a plan can model medical
 * costs rising faster than general inflation, but need not; it carries whatever
 * `customRate` the user sets rather than being pinned to CPI. When the plan enrolls
 * in Medicare, the line
 * steps from the pre-65 self-funded figure down to the authored residual at the
 * month the person turns 65; both figures are authored in today's dollars and share
 * the same forward inflation, so the residual override is that figure inflated to 65.
 * Not enrolling (or already past 65) collapses to a single segment.
 */
function buildHealthSeries(budget: BudgetValues): CashFlowSeries {
  const rate = budget.healthInflationPct / 100;
  const growth = { type: "customRate" as const, annualRate: rate };
  const yearsTo65 = MEDICARE_ELIGIBILITY_AGE - budget.currentAge;

  // Already at/past 65 and enrolling → the residual applies from month 0.
  if (budget.enrollsInMedicare && yearsTo65 <= 0) {
    return new CashFlowSeries(0, budget.postMedicareHealthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }

  const series = new CashFlowSeries(0, budget.healthMonthlyCents, growth, {
    baselineUnit: "monthly",
  });
  if (budget.enrollsInMedicare) {
    // Step down at 65: the residual (today's dollars) inflated forward to that month,
    // then it keeps growing at the same rate from its own anchor.
    const nominalResidualAt65 = Math.round(
      budget.postMedicareHealthMonthlyCents * Math.pow(1 + rate, yearsTo65),
    );
    series.addOverride(yearsTo65 * 12, nominalResidualAt65, "fromHereForward", {
      newGrowthMode: growth,
      resetAnchor: true,
    });
  }
  return series;
}

/** Age a career is assumed to begin, for reconstructing SS-covered earnings. */
const CAREER_START_AGE = 18;

/**
 * Nominal SS-covered earnings for the working ages in `[fromAge, toAge)`, assuming
 * a constant *real* (today's) salary across the whole span: each year is today's
 * salary inflated to that calendar year at CPI, keyed by calendar year. Consistent
 * with how in-model income is modelled (inflation-linked, flat in real terms). Both
 * the pre-"now" record seed and the panel's benefit calc read from this shape.
 */
function careerEarningsCents(budget: BudgetValues, fromAge: number, toAge: number): Record<number, Cents> {
  const annualSalaryNow = budget.incomeCents * 12;
  const inflationRate = budget.inflationPct / 100;
  const earnings: Record<number, Cents> = {};
  for (let age = fromAge; age < toAge; age++) {
    const year = START_YEAR + (age - budget.currentAge); // < START_YEAR for ages before "now"
    earnings[year] = Math.round(annualSalaryNow * Math.pow(1 + inflationRate, age - budget.currentAge));
  }
  return earnings;
}

/**
 * The full nominal SS-covered earnings record the plan implies — the whole career,
 * age 18 through retirement. The panel prices Social Security from this same record
 * the graph accumulates, so both surfaces report the same benefit.
 */
export function fullCareerEarningsCents(budget: BudgetValues): Record<number, Cents> {
  return careerEarningsCents(budget, CAREER_START_AGE, budget.retirementAge);
}

/**
 * Reconstruct the person's SS-covered earnings for the working years BEFORE the
 * simulation starts (the §4.6 pre-"now" summary the engine seeds from).
 *
 * Why this is needed even for someone who will work a "full" 30 years in-model:
 * the AIME formula (§5.4) sums a worker's highest 35 indexed years and always
 * divides by a fixed 420-month (35-year) window. A 35-year-old who retires at 65
 * only earns 30 in-model years, so 5 slots would be counted as $0 and drag the
 * benefit down ~1/7. A real 35-year-old has instead been earning since ~18, and
 * those years fill the record — so we seed ages 18 → today.
 */
function seedPriorEarnings(budget: BudgetValues): Record<number, Cents> {
  return careerEarningsCents(budget, CAREER_START_AGE, budget.currentAge);
}

export function createProjectionBase(budget: BudgetValues): LedgerBaseConfig {
  // Give the projection an SS basis (§5.4): a birth year derived from today's age
  // plus the pinned claiming age, so the engine accumulates earnings while working
  // and pays a Social Security benefit from the claiming age — the same lever the
  // retirement panel reasons about, now present in the graph too. Seed the years
  // worked BEFORE "now" so the benefit reflects a full career, not just in-model
  // earnings (see seedPriorEarnings).
  const person: Person = {
    id: PRIMARY_PERSON_ID,
    name: budget.name,
    birthYear: START_YEAR - budget.currentAge,
    ssClaimingAge: budget.ssClaimingAge,
    priorEarningsCents: seedPriorEarnings(budget),
  };

  const inflationRate = budget.inflationPct / 100;
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

  const healthSeries = buildHealthSeries(budget);

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

  const surplusDestination: SurplusDestination = budget.surplusSwept
    ? { kind: "swept", accountId: BROKERAGE_ID }
    : { kind: "idle" };

  return {
    horizonMonths: planHorizonMonths(budget.currentAge, budget.lifeExpectancy),
    annualInflationRate: inflationRate,
    startYear: START_YEAR,
    initialPersons: [person],
    initialAccounts: buildPlanAccounts(budget),
    initialIncomeSeries: [income],
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
