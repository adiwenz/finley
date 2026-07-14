/**
 * Turns the editable plan values (§10.2 — NOT events) into the engine's
 * `LedgerBaseConfig` for replay, including the §5.0 waterfall config (goals and
 * the four levers). The account/goal derivation is exported so the Goals panel
 * can score the same goals against the projection without duplicating the map.
 */

import {
  CashFlowSeries,
  Account,
  type Person,
  type Goal,
  type LedgerBaseConfig,
  type OwnedSeries,
  type ProjectionSeries,
  type SurplusDestination,
} from "@finley/engine";
import { HORIZON_MONTHS, INFLATION, START_YEAR } from "./config";
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

export function createProjectionBase(budget: BudgetValues): LedgerBaseConfig {
  const person: Person = { id: PRIMARY_PERSON_ID, name: budget.name };

  const incomeSeries = new CashFlowSeries(
    0,
    budget.incomeCents,
    { type: "fixed" },
    { baselineUnit: "monthly" },
  );
  const expenseSeries = new CashFlowSeries(
    0,
    budget.expenseCents,
    { type: "fixed" },
    { baselineUnit: "monthly" },
  );
  // Value edits are overrides on the artifact — never life events (§10.3 rule 1).
  for (const o of budget.expenseOverrides) {
    expenseSeries.addOverride(o.month, o.monthlyCents, o.scope);
  }

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
    horizonMonths: HORIZON_MONTHS,
    annualInflationRate: INFLATION,
    startYear: START_YEAR,
    initialPersons: [person],
    initialAccounts: buildPlanAccounts(budget),
    initialIncomeSeries: [income],
    initialExpenseSeries: [{ series: expenseSeries, ownerId: PRIMARY_PERSON_ID }],
    goals: buildPlanGoals(budget),
    sharedScheme: budget.sharedScheme,
    surplusDestination,
  };
}

export function firstInsolventMonth(series: ProjectionSeries): number | null {
  for (const m of series.months) if (m.isInsolvent) return m.month;
  return null;
}
