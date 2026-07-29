/** Opening values for a fresh plan. */

import { dollarsToCents, PRIMARY_PERSON_ID } from "@finley/engine";
import type { Plan, Job } from "@finley/engine";
import { START_YEAR } from "./config";
import { defaultBudgetTemplate, toBudgetLines } from "./components/baseAdjustments/budgetTemplate";

const DEFAULT_CURRENT_AGE = 35;
const DEFAULT_WORK_START_AGE = 18;

/**
 * The default plan's single open-ended {@link Job} — the source of truth for earned
 * income. Not a privileged "career" job: just the one a fresh plan opens with, and a
 * person may hold any number, none elevated. Real-flat salary (`realGrowthPct: 0` grows
 * at CPI, holding constant in real terms), anchored at the age the person started
 * working and ending at their retirement age. Its `startYear` seeds the pre-"now"
 * covered-earnings record; a 401(k) deferral rides on it when the user sets one.
 */
const DEFAULT_JOB: Job = {
  id: "job-1",
  ownerId: PRIMARY_PERSON_ID,
  startYear: START_YEAR - DEFAULT_CURRENT_AGE + DEFAULT_WORK_START_AGE,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(5000) * 12, realGrowthPct: 0 },
};

export const PLAN_DEFAULTS: Plan = {
  name: "Alex",
  jobs: [DEFAULT_JOB],
  // Budget lines are the sole expense authoring surface, so a fresh plan opens with the
  // prepopulated Base and the Base + Adjustments editor drives the projection.
  budgetLines: toBudgetLines(defaultBudgetTemplate()),
  openingBalanceCents: dollarsToCents(10000),
  // A cash buffer, not an investment: the engine never sells this account (it is the
  // liquid one, excluded from liquidation) and spending is charged straight against it.
  // An equity-like default quietly financed the plan out of a savings account earning
  // stock-market returns. User-settable; this is only the opening value.
  savingsReturnPct: 1,
  retirementReturnPct: 7,
  brokerageReturnPct: 7,
  sharedScheme: "proportional",
  // Two goals that outrun the surplus, so the priority tradeoff is visible.
  goals: [
    {
      id: "emergency",
      name: "Emergency fund",
      targetCents: dollarsToCents(15000),
      targetDate: 24,
      // A liquid reserve: built to target, then retained in net worth. Held as CASH, not
      // a capital-gains investment — money in savings, so its draw is tax-free and it
      // stays reachable. The cash-like return matches the account type, not equity's 7%.
      disposition: "retain",
      accountType: "cash",
      annualReturnPct: 1,
    },
    {
      id: "home",
      name: "Home down payment",
      targetCents: dollarsToCents(60000),
      targetDate: 60,
      // The down payment accumulates and is retained in net worth. A goal never moves
      // its own money out at maturity — only a timeline event does — so this needs no
      // purchase event. Near-term, saved in a taxable brokerage.
      disposition: "retain",
      accountType: "brokerage",
      annualReturnPct: 7,
    },
  ],
  // Realistic pre-65 self-funded line, still below the ~$1,200 benchmark — so pulling
  // the retirement age below 65 fires the honesty nudge.
  healthMonthlyCents: dollarsToCents(700),
  // The Medicare residual from 65 — lower than the pre-65 line, so health steps down.
  postCoverageHealthMonthlyCents: dollarsToCents(500),
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  // General inflation (CPI): income and general expenses grow at this each year.
  inflationPct: 3,
  currentAge: DEFAULT_CURRENT_AGE,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
  // Social Security is always priced from the plan's earnings via the AIME→PIA seam the
  // graph and panel share; there is no authored override.
};

export const DEFAULT_SCRUB_MONTH = 0;
