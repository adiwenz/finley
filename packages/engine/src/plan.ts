/**
 * The plan: the standing numbers that drive a projection.
 *
 * A `Plan` is the engine's primary input — the ongoing figures (income, expenses,
 * per-account returns, health-care lines, ages) that describe a household's steady
 * state, as opposed to timeline events. `createProjectionBase` maps a `Plan` (plus
 * a `ProjectionContext`) into the ledger base the simulator runs.
 */

import type { GoalType, GoalDisposal } from "./goal";
import type { OverrideScope } from "./cashFlowSeries";
import type { SharedContributionScheme } from "./projection/waterfall";

export interface ValueOverride {
  readonly month: number;
  readonly monthlyCents: number;
  readonly scope: OverrideScope;
}

/**
 * A funding goal. Priority is the goal's position in {@link Plan.goals}
 * (index 0 = funded first), so reordering the array IS reprioritizing. Each goal
 * accumulates into its own derived fund account (`goal-<id>`).
 */
interface GoalPlanBase {
  readonly id: string;
  readonly name: string;
  readonly targetCents: number;
  readonly type: GoalType;
  /**
   * Annual return on this goal's fund account, as a whole-number percent. Drives
   * both the projected growth and the short-horizon-risk flag (a near-term goal in
   * a high-return, market-risk account).
   */
  readonly annualReturnPct: number;
}

/**
 * A funding goal. Priority is the goal's position in {@link Plan.goals}
 * (index 0 = funded first), so reordering the array IS reprioritizing. Each goal
 * accumulates into its own derived fund account (`goal-<id>`).
 *
 * The `disposition`/`targetDate` pairing is the engine's {@link GoalDisposal}: a
 * disposition that fires at maturity needs a month to fire AT, so `"asap"` is rejected
 * for those. Sharing the type means the plan cannot author a goal the projection would
 * be unable to honour — it is refused where the user writes it, not where it breaks.
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
  readonly incomeCents: number;
  readonly expenseCents: number;
  readonly expenseOverrides: readonly ValueOverride[];
  readonly openingBalanceCents: number;
  /**
   * Per-account annual return, as whole-number percents. Each standing account
   * carries its own rate so, e.g., the swept brokerage can out-earn idle savings
   * (which is what makes the surplus-destination choice move net worth, not just
   * shuffle balances). Goal fund accounts carry their own rate on {@link GoalPlan}.
   */
  readonly savingsReturnPct: number;
  readonly retirementReturnPct: number;
  readonly brokerageReturnPct: number;
  /**
   * Fraction of income deferred pre-tax into the retirement account, as a
   * whole-number percent. 0 = no plan (income is fully post-tax).
   */
  readonly retirementDeferralPct: number;
  /** How shared obligations are split between partners. */
  readonly sharedScheme: SharedContributionScheme;
  /** True sweeps leftover cash to a brokerage; false idles it. */
  readonly surplusSwept: boolean;
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
  /**
   * Age the person's Social-Security-covered career is assumed to have begun —
   * the first year seeded into the pre-"now" earnings record (§4.6). User-set
   * rather than a fixed 18, because when the career started drives how many of the
   * AIME's fixed 35-year window are filled (§5.4): someone who started at 25 has
   * four fewer covered years than someone who started at 18, which lowers the
   * priced benefit. Expected to satisfy `careerStartAge ≤ currentAge`; when equal
   * there are no pre-"now" years to seed.
   */
  readonly careerStartAge: number;
  /** The pinned/desired retirement age; target mode reports on-track % against it. */
  readonly retirementAge: number;
  /** Age the portfolio must last to — the retirement survival horizon. */
  readonly lifeExpectancy: number;
  /** Pinned Social Security claiming age — an input to the check, never searched. */
  readonly ssClaimingAge: number;
}
