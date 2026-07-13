/** Opening values for a fresh plan. */

import { dollarsToCents } from "@finley/engine";
import type { BudgetValues } from "./planTypes";

export const PLAN_DEFAULTS: BudgetValues = {
  name: "Alex",
  incomeCents: dollarsToCents(5000),
  expenseCents: dollarsToCents(3500),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(10000),
  annualReturnPct: 7,
};

export const DEFAULT_SCRUB_MONTH = 0;
