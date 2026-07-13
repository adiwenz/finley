/**
 * Turns the editable plan values (§10.2 — NOT events) into the engine's
 * `LedgerBaseConfig` for replay.
 */

import {
  CashFlowSeries,
  Account,
  type Person,
  type LedgerBaseConfig,
  type ProjectionSeries,
} from "@finley/engine";
import { HORIZON_MONTHS, INFLATION, START_YEAR } from "./config";
import type { BudgetValues } from "./planTypes";

export function createProjectionBase(budget: BudgetValues): LedgerBaseConfig {
  const person: Person = { id: "p1", name: budget.name };

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

  const account = new Account({
    id: "savings",
    ownerId: "p1",
    liquid: true,
    taxTreatment: "taxable",
    openingBalanceCents: budget.openingBalanceCents,
    initialAnnualRate: budget.annualReturnPct / 100,
  });

  return {
    horizonMonths: HORIZON_MONTHS,
    annualInflationRate: INFLATION,
    startYear: START_YEAR,
    initialPersons: [person],
    initialAccounts: [account],
    initialIncomeSeries: [{ series: incomeSeries, ownerId: "p1" }],
    initialExpenseSeries: [{ series: expenseSeries, ownerId: "p1" }],
  };
}

export function firstInsolventMonth(series: ProjectionSeries): number | null {
  for (const m of series.months) if (m.isInsolvent) return m.month;
  return null;
}
