/** Opening values for a fresh plan. */

import { dollarsToCents } from "@finley/engine";
import type { BudgetValues } from "./planTypes";

export const PLAN_DEFAULTS: BudgetValues = {
  name: "Alex",
  incomeCents: dollarsToCents(5000),
  expenseCents: dollarsToCents(3500),
  expenseOverrides: [],
  openingBalanceCents: dollarsToCents(10000),
  savingsReturnPct: 7,
  retirementReturnPct: 7,
  brokerageReturnPct: 7,
  retirementDeferralPct: 0,
  sharedScheme: "proportional",
  surplusSwept: false,
  // Two goals that outrun the surplus, so the priority tradeoff is visible (§5.2).
  goals: [
    {
      id: "emergency",
      name: "Emergency fund",
      targetCents: dollarsToCents(15000),
      targetDate: 24,
      type: "horizon",
      annualReturnPct: 7,
    },
    {
      id: "home",
      name: "Home down payment",
      targetCents: dollarsToCents(60000),
      targetDate: 60,
      type: "oneTime",
      annualReturnPct: 7,
    },
  ],
  currentAge: 35,
  retirementAge: 65,
  lifeExpectancy: 90,
  ssClaimingAge: 67,
  socialSecurityAnnualCents: dollarsToCents(24000),
};

export const DEFAULT_SCRUB_MONTH = 0;
