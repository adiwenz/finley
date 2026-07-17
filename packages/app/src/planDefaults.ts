/** Opening values for a fresh plan. */

import { dollarsToCents } from "@finley/engine";
import type { Plan } from "@finley/engine";

export const PLAN_DEFAULTS: Plan = {
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
      // A liquid reserve: built to target, then retained in net worth (§5.2).
      disposition: "retain",
      annualReturnPct: 7,
    },
    {
      id: "home",
      name: "Home down payment",
      targetCents: dollarsToCents(60000),
      targetDate: 60,
      type: "oneTime",
      // Swapped into home equity via HomePurchaseEvent (§4.5) — an asset swap (§5.2).
      disposition: "convertToEquity",
      annualReturnPct: 7,
    },
  ],
  // A realistic pre-65 self-funded line, but still below the ~$1,200 benchmark —
  // so pulling the retirement age below 65 makes the honesty nudge fire (§5.4).
  healthMonthlyCents: dollarsToCents(700),
  // The Medicare residual from 65 — lower than the pre-65 line, so health steps down.
  postCoverageHealthMonthlyCents: dollarsToCents(500),
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  // General inflation (CPI): income and general expenses grow at this each year.
  inflationPct: 3,
  currentAge: 35,
  // The age the SS-covered career is assumed to have begun — seeds the pre-"now"
  // earnings record, so it drives the priced benefit (§4.6/§5.4). User-editable.
  careerStartAge: 18,
  retirementAge: 65,
  lifeExpectancy: 90,
  ssClaimingAge: 67,
  // Social Security is always priced from the plan's earnings (the AIME→PIA seam the
  // graph and panel share); there is no authored override.
};

export const DEFAULT_SCRUB_MONTH = 0;
