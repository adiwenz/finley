/** Opening values for a fresh plan. */

import { dollarsToCents, PRIMARY_PERSON_ID } from "@finley/engine";
import type { Plan, Job } from "@finley/engine";
import { START_YEAR } from "./config";
import { defaultBudgetTemplate, toBudgetLines } from "./components/baseAdjustments/budgetTemplate";

const DEFAULT_CURRENT_AGE = 35;
const DEFAULT_CAREER_START_AGE = 18;

/**
 * The default plan's single open-ended "career" {@link Job} (§1/§6, issue #72) — the
 * source of truth for earned income now that the scalar `incomeCents` /
 * `careerStartAge` / `retirementDeferralPct` fields are gone. A real-flat salary
 * (`realGrowthPct: 0`, so it grows at CPI and holds constant in real terms — the exact
 * behaviour the scalar income lever had) anchored at the age the career began, ending
 * at the person's retirement age. Its `startYear` seeds the pre-"now" covered-earnings
 * record (§4.6); a 401(k) deferral, when the user sets one, rides on it (§11).
 */
const DEFAULT_CAREER_JOB: Job = {
  id: "career",
  ownerId: PRIMARY_PERSON_ID,
  startYear: START_YEAR - DEFAULT_CURRENT_AGE + DEFAULT_CAREER_START_AGE,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(5000) * 12, realGrowthPct: 0 },
};

export const PLAN_DEFAULTS: Plan = {
  name: "Alex",
  jobs: [DEFAULT_CAREER_JOB],
  // The line-item budget is the source of truth for spending: a non-empty
  // `budgetLines` replaces the scalar `expenseCents` series wholesale (see
  // `projectionBase.ts`), so a fresh plan opens with the prepopulated Base and the
  // Base + Adjustments editor drives the projection. `expenseCents` is retained only
  // as the engine-native fallback; it is inert while lines exist.
  expenseCents: dollarsToCents(3500),
  expenseOverrides: [],
  budgetLines: toBudgetLines(defaultBudgetTemplate()),
  openingBalanceCents: dollarsToCents(10000),
  // A cash buffer, not an investment: the engine never sells this account (it is the
  // liquid one, excluded from liquidation) and spending is charged straight against
  // it. An equity-like default here quietly financed the plan out of a savings
  // account earning stock-market returns. User-settable; this is only the opening value.
  savingsReturnPct: 1,
  retirementReturnPct: 7,
  brokerageReturnPct: 7,
  sharedScheme: "proportional",
  // Two goals that outrun the surplus, so the priority tradeoff is visible (§5.2).
  goals: [
    {
      id: "emergency",
      name: "Emergency fund",
      targetCents: dollarsToCents(15000),
      targetDate: 24,
      // A liquid reserve: built to target, then retained in net worth (§5.2).
      disposition: "retain",
      annualReturnPct: 7,
    },
    {
      id: "home",
      name: "Home down payment",
      targetCents: dollarsToCents(60000),
      targetDate: 60,
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
  currentAge: DEFAULT_CURRENT_AGE,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
  // Social Security is always priced from the plan's earnings (the AIME→PIA seam the
  // graph and panel share); there is no authored override.
};

export const DEFAULT_SCRUB_MONTH = 0;
