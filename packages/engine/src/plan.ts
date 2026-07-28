/**
 * The plan: the standing numbers that drive a projection.
 *
 * A `Plan` is the engine's primary input — the ongoing figures (income, expenses,
 * per-account returns, health-care lines, ages) that describe a household's steady
 * state, as opposed to timeline events. `createProjectionBase` maps a `Plan` (plus
 * a `ProjectionContext`) into the ledger base the simulator runs.
 */

import type { GoalDisposal } from "./goal";
import type { OverrideScope } from "./cashFlowSeries";
import type { SharedContributionScheme } from "./projection/waterfall";
import type { Job } from "./job";
import type { BudgetLine } from "./budgetLine";

export interface ValueOverride {
  readonly month: number;
  readonly monthlyCents: number;
  readonly scope: OverrideScope;
}

/**
 * The kind of account a goal's fund is held in — the thing a person actually knows
 * ("my emergency fund is in savings"). It is the source of truth from which the
 * projection derives the fund account's {@link import("./simAccount").SimAccountTaxProfile}
 * and its liquidity, rather than hard-coding every goal to a capital-gains investment.
 * Whole-account-type list, so the four standing vehicles are all
 * expressible:
 *  - `"cash"`      — a cash/savings buffer: tax-free withdrawal (interest taxed at
 *                    accrual), and liquid, because a cash reserve's whole purpose is
 *                    to be reachable;
 *  - `"brokerage"` — a taxable investment: post-tax in, capital-gains out, and liquid
 *                    (a taxable brokerage is sellable on demand);
 *  - `"taxExempt"` — a Roth-like vehicle: post-tax in, tax-free out, growth untaxed,
 *                    illiquid (locked up by age/penalty rules);
 *  - `"preTax"`    — a tax-deferred retirement account: pre-tax in, ordinary-income
 *                    out, illiquid.
 */
export type GoalAccountType = "cash" | "brokerage" | "taxExempt" | "preTax";

/**
 * The surplus-cash destination lever, in plan-authoring terms: where each month's
 * leftover cash — the residual after every goal and standing contribution is funded —
 * lands. `"savings"` (the default) idles it in the liquid Cash savings account, where
 * it earns {@link Plan.savingsReturnPct}; `"brokerage"` sweeps it into the taxable
 * brokerage, where it earns {@link Plan.brokerageReturnPct} instead. This is the
 * user-facing shape of the engine's {@link import("./projection/waterfall").SurplusDestination}
 * (`idle` / `swept`); `createProjectionBase` maps the two together, keeping the
 * concrete account id inside the engine.
 */
export type SurplusCashDestination = "savings" | "brokerage";

/**
 * A funding goal. Priority is the goal's position in {@link Plan.goals}
 * (index 0 = funded first), so reordering the array IS reprioritizing. Each goal
 * accumulates into its own derived fund account (`goal-<id>`).
 */
interface GoalPlanBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  /**
   * Annual return on this goal's fund account, as a whole-number percent. Drives
   * both the projected growth and the short-horizon-risk flag (a near-term goal in
   * a high-return, market-risk account).
   */
  readonly annualReturnPct: number;
  /**
   * The {@link GoalAccountType} the fund is held in — the fund account's tax profile
   * and liquidity derive from it. Optional: a goal that never declared a
   * type keeps the `"brokerage"` default (capital-gains, liquid).
   */
  readonly accountType?: GoalAccountType;
}

/**
 * A funding goal. Priority is the goal's position in {@link Plan.goals}
 * (index 0 = funded first), so reordering the array IS reprioritizing. Each goal
 * accumulates into its own derived fund account (`goal-<id>`).
 *
 * The `disposition`/`targetDate` pairing is the engine's {@link GoalDisposal}. Both
 * dispositions are purely descriptive, so either accepts a concrete month or
 * `"asap"`. Sharing the type keeps the plan and the sim goal from drifting apart.
 */
export type GoalPlan = GoalPlanBase & GoalDisposal;

/**
 * The ongoing numbers that describe a household's steady state, with no timeline
 * event. Held as one object so its identity only changes when a value actually
 * changes; that lets a consumer memoize the projection base on `[plan]`. Treated
 * as immutable — replace it, never mutate in place.
 */
export interface Plan {
  readonly name: string;
  readonly expenseCents: number;
  readonly expenseOverrides: readonly ValueOverride[];
  readonly openingBalanceCents: number;
  /**
   * Per-account annual return, as whole-number percents. Each standing account
   * carries its own rate so, e.g., a brokerage can out-earn idle savings. Goal
   * fund accounts carry their own rate on {@link GoalPlan}.
   */
  readonly savingsReturnPct: number;
  readonly retirementReturnPct: number;
  readonly brokerageReturnPct: number;
  /** How shared obligations are split between partners. */
  readonly sharedScheme: SharedContributionScheme;
  /**
   * The surplus-cash destination lever: where the month's leftover cash lands.
   * Optional — defaults to `"savings"` (idle in the liquid account, the historical
   * behaviour), so no existing `Plan` literal needs editing. `"brokerage"` sweeps the
   * surplus into the taxable brokerage so it earns the brokerage return instead of the
   * cash rate.
   */
  readonly surplusCashTo?: SurplusCashDestination;
  /** Funding goals in priority order (array index = priority). */
  readonly goals: readonly GoalPlan[];
  /**
   * Authored monthly pre-public-coverage health-care expense in cents — the
   * self-funded figure paid until public health coverage begins (and for life when
   * {@link enrollsInPublicHealthCoverage} is false). A dedicated line, separate from and
   * ADDITIVE to {@link expenseCents} (which carries non-health spend), modelled as a
   * real expense in both projections and growing at {@link healthInflationPct}. It
   * is the figure the early-retiree honesty check compares against the pre-coverage
   * self-funded benchmark (understating it while retiring early trips a nudge).
   */
  readonly healthMonthlyCents: number;
  /**
   * Authored monthly health-care expense in cents from the public-coverage age
   * onward — the residual (premiums/out-of-pocket) that remains after coverage
   * begins. In today's dollars, grown at {@link healthInflationPct}. Set to 0 to
   * model forgoing coverage. Used only when {@link enrollsInPublicHealthCoverage}; ignored
   * otherwise.
   */
  readonly postCoverageHealthMonthlyCents: number;
  /**
   * Whether the plan enrols in public health coverage at the coverage age. True →
   * health steps from {@link healthMonthlyCents} down to
   * {@link postCoverageHealthMonthlyCents} at the coverage age. False → the
   * self-funded line runs for life with no step.
   */
  readonly enrollsInPublicHealthCoverage: boolean;
  /**
   * Annual growth of the health lines, as a whole-number percent. Health is
   * modelled like any other budget item but with its own rate. In the nominal
   * projection it compounds the health series; in the (real-dollars) retirement
   * drawdown it compounds health net of {@link inflationPct}, so health rises in
   * real terms only insofar as it outpaces general inflation.
   */
  readonly healthInflationPct: number;
  /**
   * General inflation (CPI), as a whole-number percent. Income and general expenses
   * grow at this rate each year in the nominal projection (so they hold constant in
   * real terms), and it is the rate every nominal figure is de-inflated by to give
   * the real (today's-dollars) net-worth line and the retirement drawdown.
   */
  readonly inflationPct: number;
  /** Age at "now" — the base the retirement solver counts years from. */
  readonly currentAge: number;
  /** The pinned/desired retirement age; target mode reports on-track % against it. */
  readonly retirementAge: number;
  /** Age the portfolio must last to — the retirement survival horizon. */
  readonly lifeExpectancy: number;
  /** Pinned government-benefit claiming age — an input to the check, never searched. */
  readonly benefitClaimingAge: number;
  /**
   * Optional cost-of-living rate for the government retirement benefit, as a
   * DECIMAL rate (e.g. `0.02`). When unset, the benefit COLA is COUPLED to general
   * inflation ({@link inflationPct}); setting it DECOUPLES the two — a benefit that
   * indexes below (or above) general CPI. Optional so no existing `Plan` literal
   * needs editing.
   */
  readonly benefitColaRate?: number;
  /**
   * First-class {@link Job} standing model — the **source of
   * truth for earned income** since the hinge deleted the scalar `incomeCents` /
   * `careerStartAge` path. `createProjectionBase` compiles these jobs into the base
   * income series (the primary member's open-ended jobs end at
   * {@link retirementAge}; fixed-term jobs carry their own end). A person's covered
   * SS earnings, including the pre-"now" record, are derived directly from the
   * jobs' spans and salaries — so when a person started working is now the earliest
   * job's `startYear`, not a separate scalar field.
   */
  readonly jobs: readonly Job[];
  /**
   * First-class line-item {@link BudgetLine} budget: a prioritized list of dollar
   * line items — expenses and account
   * contributions — each with a `{ literal, fill-to-limit, goal-paced }` amount
   * source and optional spans + dated overrides. When present and non-empty,
   * `createProjectionBase` compiles the *expense* lines into the base expense series
   * in place of the scalar {@link expenseCents}; contribution lines resolve via
   * {@link import("./budgetLine").resolveBudget}. Optional: an engine-native fixture
   * may still author spending through the scalar {@link expenseCents} series.
   */
  readonly budgetLines?: readonly BudgetLine[];
}
