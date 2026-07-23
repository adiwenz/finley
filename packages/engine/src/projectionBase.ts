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

import { SimCashFlowSeries } from "./cashFlowSeries";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
} from "./simAccount";
import type { SimOwnedSeries, ProjectionSeries } from "./projection/simulate";
import type { SimGoal, GoalDisposal } from "./goal";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { SurplusDestination } from "./projection/waterfall";
import type { Jurisdiction } from "./jurisdiction";
import type { Plan, GoalPlan } from "./plan";
import { type Person } from "./person";
import { compilePersonIncomeSeries } from "./compilePerson";
import { compileExpenseBudgetLines } from "./compileBudget";

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
/** The pre-tax retirement account a {@link Job}'s 401(k) deferral funds (§11). */
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
export function buildPlanAccounts(budget: Plan): SimAccount[] {
  const accounts: SimAccount[] = [
    new SimAccount({
      id: SAVINGS_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: true,
      // A cash buffer, not an investment: money went in post-tax and comes out
      // untaxed. It carried a capital-gains profile, which was wrong on its face and
      // dangerous the moment anything treats savings as sellable — a capital-gains
      // draw counts toward provisional income and pulls the government benefit into
      // tax (see federalTax's provisional-income note). Its withdrawal is tax-free
      // BECAUSE its interest is taxed as ordinary income at accrual (§#94), which the
      // cash profile — not the genuinely tax-exempt one — declares.
      taxProfile: CASH_INTEREST_TAX_PROFILE,
      openingBalanceCents: budget.openingBalanceCents,
      initialAnnualRate: budget.savingsReturnPct / 100,
    }),
    new SimAccount({
      id: RETIREMENT_ID,
      ownerId: PRIMARY_PERSON_ID,
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: budget.retirementReturnPct / 100,
    }),
    new SimAccount({
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
      new SimAccount({
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
 * The plan's goals as engine `SimGoal`s. Array order is priority (index 0 first),
 * so reordering the plan array reprioritizes without touching anything else.
 */
export function buildPlanGoals(budget: Plan): SimGoal[] {
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
function buildHealthSeries(budget: Plan, coverageAge: number | undefined): SimCashFlowSeries {
  const rate = budget.healthInflationPct / 100;
  const growth = { type: "customRate" as const, annualRate: rate };
  // The step exists only when the plan enrols AND the jurisdiction offers a
  // coverage age; without one there is no public coverage to step down to.
  const enrolls = budget.enrollsInPublicHealthCoverage && coverageAge !== undefined;
  if (!enrolls) {
    return new SimCashFlowSeries(0, budget.healthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }
  const yearsToCoverage = coverageAge - budget.currentAge;

  // Already at/past the coverage age → the residual applies from month 0.
  if (yearsToCoverage <= 0) {
    return new SimCashFlowSeries(0, budget.postCoverageHealthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }

  const series = new SimCashFlowSeries(0, budget.healthMonthlyCents, growth, {
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

export function createProjectionBase(budget: Plan, ctx: ProjectionContext): LedgerBaseConfig {
  const { startYear } = ctx;
  const inflationRate = budget.inflationPct / 100;
  const birthYear = startYear - budget.currentAge;

  // §1 (issue #64, #72 hinge): the standing Job model is the sole source of truth for
  // earned income. Assemble the primary member as an authoring {@link Person} —
  // identity, the retirement/benefit inputs, and the authored jobs — and compile it
  // for the sim: the pre-"now" covered-earnings record and forward income series both
  // fall directly out of the jobs' spans and salaries (§4.6/§6), never a scalar lever.
  const standingPerson: Person = {
    id: PRIMARY_PERSON_ID,
    name: budget.name,
    birthYear,
    retirementTargetAge: budget.retirementAge,
    benefitClaimingAge: budget.benefitClaimingAge,
    jobs: budget.jobs,
  };

  // General (non-health) expenses grow with CPI — flat in real terms.
  const expenseSeries = new SimCashFlowSeries(
    0,
    budget.expenseCents,
    { type: "inflationLinked", annualRate: inflationRate },
    { baselineUnit: "monthly" },
  );
  // Value edits are overrides on the artifact — never life events (§10.3 rule 1).
  for (const o of budget.expenseOverrides) {
    expenseSeries.addOverride(o.month, o.monthlyCents, o.scope);
  }

  // Additive branch (§12, issue #67): a non-empty line-item budget is the new
  // source of truth for spending — compile its EXPENSE lines (spans + dated
  // overrides ride into each series) and use them in place of the scalar
  // `expenseCents` series. Contribution lines route to the contribution channels
  // (resolveBudget), not here; they land in the waterfall in the #72 rewire. When
  // absent/empty, the scalar expense series above is used (still live until #72).
  const budgetLines = budget.budgetLines;
  // Every expense line is owned by the primary person, but that owner is inert
  // today: the simulator sums all expense series into one household obligation
  // and splits it by `sharedScheme`, never reading an expense's ownerId. So every
  // expense is effectively shared. Issue #84 will make an expense line optionally
  // *personal* to its owner (charged against that person's take-home first), at
  // which point this owner tag starts doing work instead of being a placeholder. 
  // See issue 84.
  const generalExpenseSeries: readonly SimOwnedSeries[] =
    budgetLines != null && budgetLines.length > 0
      ? compileExpenseBudgetLines(budgetLines, PRIMARY_PERSON_ID, inflationRate)
      : [{ series: expenseSeries, ownerId: PRIMARY_PERSON_ID, label: "Expenses" }];

  const healthSeries = buildHealthSeries(budget, ctx.jurisdiction.publicHealthCoverageAge);

  // Each job compiles into its own forward income {@link SimOwnedSeries}, running from
  // "now" (or the job's later start) to its end (§6). Pre-tax 401(k) deferral and any
  // employer match ride on the job (§11), compiled into the source's plan descriptor.
  const initialIncomeSeries: readonly SimOwnedSeries[] = compilePersonIncomeSeries(
    standingPerson,
    startYear,
    inflationRate,
  );

  // Leftover cash idles in the liquid account by default; a household that wants it
  // invested authors a contribution budget line to the brokerage (§12/§15). The
  // scalar "sweep everything" lever is gone with the #72 hinge.
  const surplusDestination: SurplusDestination = { kind: "idle" };

  return {
    horizonMonths: Math.max(0, (budget.lifeExpectancy - budget.currentAge) * 12),
    annualInflationRate: inflationRate,
    benefitColaRate: budget.benefitColaRate,
    startYear,
    // The roster holds authoring Persons (§8); the sim's SimPerson is derived at the
    // sim boundary (buildHouseholdSimInput → compilePerson), never here.
    initialPersons: [standingPerson],
    initialAccounts: buildPlanAccounts(budget),
    initialIncomeSeries,
    initialExpenseSeries: [
      ...generalExpenseSeries,
      { series: healthSeries, ownerId: PRIMARY_PERSON_ID, label: "Healthcare" },
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
