/** Opening values for a fresh plan. */

import { dollarsToCents, Projection } from "@finley/engine";
import type { Plan, ScenarioInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import { defaultBudgetTemplate, toBudgetLines } from "./components/baseAdjustments/budgetTemplate";

const DEFAULT_CURRENT_AGE = 35;
const DEFAULT_WORK_START_AGE = 18;

/**
 * The default plan authored ID-free: the engine mints every id as `fromInput` applies this,
 * so no hand-written `job-1`/`emergency`/`home` string can become a second source of identity
 * beside the counter. Budget lines are the exception — see {@link PLAN_DEFAULTS}.
 *
 * The single open-ended {@link import("@finley/engine").JobEntry} is the source of truth for
 * earned income. Not a privileged "career" job: just the one a fresh plan opens with, and a
 * person may hold any number, none elevated. Real-flat salary (`realGrowthPct: 0` grows at CPI,
 * holding constant in real terms), anchored at the age the person started working and open-ended
 * (`endYear: null`); its `startYear` seeds the pre-"now" covered-earnings record and a 401(k)
 * deferral rides on it when the user sets one. `ownerRef` is omitted, so the job binds to the
 * primary person.
 */
const DEFAULT_INPUT: ScenarioInput = {
  name: "Alex",
  startYear: START_YEAR,
  jobs: [
    {
      startYear: START_YEAR - DEFAULT_CURRENT_AGE + DEFAULT_WORK_START_AGE,
      endYear: null,
      salary: { startingSalaryCents: dollarsToCents(5000) * 12, realGrowthPct: 0 },
    },
  ],
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

// Built once at module load under the same jurisdiction the app projects with. The input
// carries no events, so no jurisdiction-gated check (the §4.5 down-payment gate, deferral caps)
// can fire — the plan produced is identical under any jurisdiction — but building under the real
// one keeps the default plan honest with the running app. A refusal here is an authoring bug in
// `DEFAULT_INPUT`, not runtime input, so it is fatal rather than a recoverable result.
const built = Projection.fromInput(DEFAULT_INPUT, usJurisdiction);
if (!built.ok) throw new Error(`PLAN_DEFAULTS is not a valid ScenarioInput: ${built.error.reason}`);

/**
 * A fresh plan's opening values. Its job and goals carry engine-minted ids; its budget lines
 * keep the stable label-keys {@link defaultBudgetTemplate} assigns, since the chart, overrides
 * and `allocations()` key on them and those keys are authored, not engine identity (the same
 * `id ?? label` convention `toBudgetLines` applies). Budget lines are the sole expense authoring
 * surface, so a fresh plan opens with the prepopulated Base and the Base + Adjustments editor
 * drives the projection.
 */
export const PLAN_DEFAULTS: Plan = {
  ...built.projection.plan,
  budgetLines: toBudgetLines(defaultBudgetTemplate()),
};

export const DEFAULT_SCRUB_MONTH = 0;
